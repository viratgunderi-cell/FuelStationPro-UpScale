/**
 * FuelStation Pro - Smart Alerts System
 * Monitors fuel levels, cash, shifts, and sales patterns
 */

const { pool } = require('./schema');

class AlertSystem {
  constructor() {
    this.monitoringIntervals = new Map();
  }

  /**
   * Start monitoring for a tenant
   */
  async startMonitoring(tenantId) {
    if (this.monitoringIntervals.has(tenantId)) {
      return; // Already monitoring
    }

    console.log(`[Alerts] Starting monitoring for tenant: ${tenantId}`);

    // Low fuel check - every 30 minutes
    const fuelInterval = setInterval(() => {
      this.checkLowFuel(tenantId).catch(err => 
        console.error(`[Alerts] Low fuel check error for ${tenantId}:`, err)
      );
    }, 30 * 60 * 1000);

    // High cash check - every 15 minutes
    const cashInterval = setInterval(() => {
      this.checkHighCash(tenantId).catch(err => 
        console.error(`[Alerts] High cash check error for ${tenantId}:`, err)
      );
    }, 15 * 60 * 1000);

    // Unclosed shifts check - every hour
    const shiftInterval = setInterval(() => {
      this.checkUnclosedShifts(tenantId).catch(err => 
        console.error(`[Alerts] Unclosed shifts check error for ${tenantId}:`, err)
      );
    }, 60 * 60 * 1000);

    this.monitoringIntervals.set(tenantId, { fuelInterval, cashInterval, shiftInterval });

    // Run initial checks
    await this.runAllChecks(tenantId);
  }

  /**
   * Stop monitoring for a tenant
   */
  stopMonitoring(tenantId) {
    const intervals = this.monitoringIntervals.get(tenantId);
    if (intervals) {
      clearInterval(intervals.fuelInterval);
      clearInterval(intervals.cashInterval);
      clearInterval(intervals.shiftInterval);
      this.monitoringIntervals.delete(tenantId);
      console.log(`[Alerts] Stopped monitoring for tenant: ${tenantId}`);
    }
  }

  /**
   * Run all monitoring checks
   */
  async runAllChecks(tenantId) {
    await Promise.allSettled([
      this.checkLowFuel(tenantId),
      this.checkHighCash(tenantId),
      this.checkUnclosedShifts(tenantId)
    ]);
  }

  /**
   * Check for low fuel levels in tanks
   */
  async checkLowFuel(tenantId) {
    try {
      const result = await pool.query(`
        SELECT tank_id, fuel_type, current_level, capacity,
               (current_level::float / capacity * 100) as percentage
        FROM tanks
        WHERE tenant_id = $1
          AND active = true
          AND current_level < 500
        ORDER BY percentage ASC
      `, [tenantId]);

      for (const tank of result.rows) {
        await this.createAlert(tenantId, {
          type: 'low_fuel',
          severity: tank.percentage < 10 ? 'critical' : 'warning',
          title: `Low fuel in ${tank.fuel_type} tank`,
          message: `Tank ${tank.tank_id} (${tank.fuel_type}) is at ${Math.round(tank.percentage)}% (${tank.current_level}L remaining)`,
          data: { tank_id: tank.tank_id, level: tank.current_level, percentage: tank.percentage }
        });
      }
    } catch (error) {
      console.error('[Alerts] Low fuel check error:', error);
    }
  }

  /**
   * Check for high cash amounts
   */
  async checkHighCash(tenantId) {
    try {
      // Calculate today's cash sales
      const result = await pool.query(`
        SELECT SUM(amount) as total_cash
        FROM sales
        WHERE tenant_id = $1
          AND payment_method = 'cash'
          AND DATE(timestamp AT TIME ZONE 'Asia/Kolkata') = CURRENT_DATE
      `, [tenantId]);

      const totalCash = parseFloat(result.rows[0]?.total_cash || 0);

      if (totalCash > 50000) {
        await this.createAlert(tenantId, {
          type: 'high_cash',
          severity: totalCash > 100000 ? 'critical' : 'warning',
          title: 'High cash amount',
          message: `Total cash sales today: ₹${totalCash.toFixed(2)}. Consider banking deposit.`,
          data: { amount: totalCash }
        });
      }
    } catch (error) {
      console.error('[Alerts] High cash check error:', error);
    }
  }

  /**
   * Check for unclosed shifts
   */
  async checkUnclosedShifts(tenantId) {
    try {
      const result = await pool.query(`
        SELECT e.id, e.name, e.shift,
               EXTRACT(EPOCH FROM (NOW() - s.start_time))/3600 as hours_open
        FROM shifts s
        JOIN employees e ON e.id = s.employee_id
        WHERE s.tenant_id = $1
          AND s.end_time IS NULL
          AND s.start_time < NOW() - INTERVAL '2 hours'
        ORDER BY s.start_time ASC
      `, [tenantId]);

      for (const shift of result.rows) {
        await this.createAlert(tenantId, {
          type: 'unclosed_shift',
          severity: shift.hours_open > 12 ? 'critical' : 'warning',
          title: `Shift not closed - ${shift.name}`,
          message: `${shift.name} (${shift.shift} shift) has been open for ${Math.round(shift.hours_open)} hours`,
          data: { employee_id: shift.id, hours: shift.hours_open }
        });
      }
    } catch (error) {
      console.error('[Alerts] Unclosed shifts check error:', error);
    }
  }

  /**
   * Create or update an alert
   */
  async createAlert(tenantId, alertData) {
    try {
      // Check if similar alert exists and is recent
      const existing = await pool.query(`
        SELECT id, created_at
        FROM alerts
        WHERE tenant_id = $1
          AND type = $2
          AND acknowledged = false
          AND created_at > NOW() - INTERVAL '1 hour'
        ORDER BY created_at DESC
        LIMIT 1
      `, [tenantId, alertData.type]);

      if (existing.rows.length > 0) {
        // Update existing alert
        await pool.query(`
          UPDATE alerts
          SET message = $1, data = $2, updated_at = NOW()
          WHERE id = $3
        `, [alertData.message, JSON.stringify(alertData.data), existing.rows[0].id]);
      } else {
        // Create new alert
        await pool.query(`
          INSERT INTO alerts (tenant_id, type, severity, title, message, data)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          tenantId,
          alertData.type,
          alertData.severity,
          alertData.title,
          alertData.message,
          JSON.stringify(alertData.data)
        ]);
      }
    } catch (error) {
      console.error('[Alerts] Create alert error:', error);
    }
  }

  /**
   * Get active alerts for a tenant
   */
  async getActiveAlerts(tenantId) {
    try {
      const result = await pool.query(`
        SELECT id, type, severity, title, message, data, created_at, updated_at
        FROM alerts
        WHERE tenant_id = $1
          AND acknowledged = false
        ORDER BY 
          CASE severity 
            WHEN 'critical' THEN 1
            WHEN 'warning' THEN 2
            ELSE 3
          END,
          created_at DESC
      `, [tenantId]);

      return result.rows;
    } catch (error) {
      console.error('[Alerts] Get active alerts error:', error);
      return [];
    }
  }

  /**
   * Acknowledge an alert
   */
  async acknowledgeAlert(alertId, userId) {
    try {
      await pool.query(`
        UPDATE alerts
        SET acknowledged = true,
            acknowledged_by = $1,
            acknowledged_at = NOW()
        WHERE id = $2
      `, [userId, alertId]);
      return true;
    } catch (error) {
      console.error('[Alerts] Acknowledge alert error:', error);
      return false;
    }
  }

  /**
   * Get alert statistics
   */
  async getAlertStats(tenantId, days = 7) {
    try {
      const result = await pool.query(`
        SELECT 
          type,
          COUNT(*) as count,
          COUNT(CASE WHEN severity = 'critical' THEN 1 END) as critical_count,
          COUNT(CASE WHEN severity = 'warning' THEN 1 END) as warning_count,
          AVG(EXTRACT(EPOCH FROM (acknowledged_at - created_at))/60) as avg_response_minutes
        FROM alerts
        WHERE tenant_id = $1
          AND created_at > NOW() - INTERVAL '${days} days'
        GROUP BY type
        ORDER BY count DESC
      `, [tenantId]);

      return result.rows;
    } catch (error) {
      console.error('[Alerts] Get alert stats error:', error);
      return [];
    }
  }
}

// Singleton instance
const alertSystem = new AlertSystem();

module.exports = {
  alertSystem,
  startMonitoring: (tenantId) => alertSystem.startMonitoring(tenantId),
  stopMonitoring: (tenantId) => alertSystem.stopMonitoring(tenantId),
  runAllChecks: (tenantId) => alertSystem.runAllChecks(tenantId),
  getActiveAlerts: (tenantId) => alertSystem.getActiveAlerts(tenantId),
  acknowledgeAlert: (alertId, userId) => alertSystem.acknowledgeAlert(alertId, userId),
  getAlertStats: (tenantId, days) => alertSystem.getAlertStats(tenantId, days)
};
