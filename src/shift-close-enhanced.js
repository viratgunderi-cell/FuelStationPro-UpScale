/**
 * FuelStation Pro - Enhanced One-Tap Shift Close
 * Automatically fetches data and generates complete shift summary
 */

const { pool } = require('./schema');

/**
 * Auto-close shift with complete data collection
 */
async function autoCloseShift(tenantId, employeeId) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // 1. Find active shift
    const shiftResult = await client.query(`
      SELECT id, start_time, shift_type
      FROM shifts
      WHERE tenant_id = $1
        AND employee_id = $2
        AND end_time IS NULL
      ORDER BY start_time DESC
      LIMIT 1
    `, [tenantId, employeeId]);

    if (shiftResult.rows.length === 0) {
      throw new Error('No active shift found for this employee');
    }

    const shift = shiftResult.rows[0];
    const shiftId = shift.id;
    const startTime = shift.start_time;

    // 2. Get all sales during this shift
    const salesResult = await client.query(`
      SELECT 
        fuel_type,
        COUNT(*) as transaction_count,
        SUM(quantity) as total_liters,
        SUM(amount) as total_amount,
        payment_method
      FROM sales
      WHERE tenant_id = $1
        AND employee_id = $2
        AND timestamp >= $3
      GROUP BY fuel_type, payment_method
      ORDER BY fuel_type, payment_method
    `, [tenantId, employeeId, startTime]);

    // 3. Calculate totals
    const totals = {
      total_transactions: 0,
      total_amount: 0,
      total_liters: 0,
      cash_amount: 0,
      card_amount: 0,
      upi_amount: 0,
      by_fuel_type: {},
      by_payment_method: {}
    };

    salesResult.rows.forEach(row => {
      totals.total_transactions += parseInt(row.transaction_count);
      totals.total_amount += parseFloat(row.total_amount);
      totals.total_liters += parseFloat(row.total_liters);

      // By payment method
      const paymentMethod = row.payment_method;
      const amount = parseFloat(row.total_amount);
      
      if (paymentMethod === 'cash') totals.cash_amount += amount;
      else if (paymentMethod === 'card') totals.card_amount += amount;
      else if (paymentMethod === 'upi') totals.upi_amount += amount;

      if (!totals.by_payment_method[paymentMethod]) {
        totals.by_payment_method[paymentMethod] = { count: 0, amount: 0 };
      }
      totals.by_payment_method[paymentMethod].count += parseInt(row.transaction_count);
      totals.by_payment_method[paymentMethod].amount += amount;

      // By fuel type
      const fuelType = row.fuel_type;
      if (!totals.by_fuel_type[fuelType]) {
        totals.by_fuel_type[fuelType] = { count: 0, liters: 0, amount: 0 };
      }
      totals.by_fuel_type[fuelType].count += parseInt(row.transaction_count);
      totals.by_fuel_type[fuelType].liters += parseFloat(row.total_liters);
      totals.by_fuel_type[fuelType].amount += amount;
    });

    // 4. Get current meter readings (if available)
    const meterResult = await client.query(`
      SELECT pump_id, fuel_type, reading
      FROM pump_readings
      WHERE tenant_id = $1
        AND recorded_at >= $2
      ORDER BY recorded_at DESC
    `, [tenantId, startTime]);

    const meterReadings = meterResult.rows;

    // 5. Update shift with all data
    const endTime = new Date();
    const durationHours = (endTime - new Date(startTime)) / (1000 * 60 * 60);

    await client.query(`
      UPDATE shifts
      SET 
        end_time = $1,
        total_sales = $2,
        total_transactions = $3,
        cash_amount = $4,
        card_amount = $5,
        upi_amount = $6,
        data_json = $7
      WHERE id = $8
    `, [
      endTime,
      totals.total_amount,
      totals.total_transactions,
      totals.cash_amount,
      totals.card_amount,
      totals.upi_amount,
      JSON.stringify({
        duration_hours: durationHours.toFixed(2),
        by_fuel_type: totals.by_fuel_type,
        by_payment_method: totals.by_payment_method,
        meter_readings: meterReadings,
        closed_at: endTime.toISOString(),
        auto_closed: true
      }),
      shiftId
    ]);

    await client.query('COMMIT');

    // 6. Return complete summary
    return {
      success: true,
      shift_id: shiftId,
      shift_type: shift.shift_type,
      start_time: startTime,
      end_time: endTime,
      duration_hours: durationHours.toFixed(2),
      summary: {
        total_transactions: totals.total_transactions,
        total_amount: totals.total_amount,
        total_liters: totals.total_liters,
        cash_amount: totals.cash_amount,
        card_amount: totals.card_amount,
        upi_amount: totals.upi_amount,
        by_fuel_type: totals.by_fuel_type,
        by_payment_method: totals.by_payment_method
      },
      meter_readings: meterReadings
    };

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get shift summary without closing (for preview)
 */
async function getShiftSummary(tenantId, employeeId) {
  try {
    // Find active shift
    const shiftResult = await pool.query(`
      SELECT id, start_time, shift_type
      FROM shifts
      WHERE tenant_id = $1
        AND employee_id = $2
        AND end_time IS NULL
      ORDER BY start_time DESC
      LIMIT 1
    `, [tenantId, employeeId]);

    if (shiftResult.rows.length === 0) {
      return { success: false, message: 'No active shift found' };
    }

    const shift = shiftResult.rows[0];
    const startTime = shift.start_time;

    // Get sales summary
    const salesResult = await pool.query(`
      SELECT 
        COUNT(*) as total_transactions,
        SUM(amount) as total_amount,
        SUM(quantity) as total_liters,
        SUM(CASE WHEN payment_method = 'cash' THEN amount ELSE 0 END) as cash_amount,
        SUM(CASE WHEN payment_method = 'card' THEN amount ELSE 0 END) as card_amount,
        SUM(CASE WHEN payment_method = 'upi' THEN amount ELSE 0 END) as upi_amount
      FROM sales
      WHERE tenant_id = $1
        AND employee_id = $2
        AND timestamp >= $3
    `, [tenantId, employeeId, startTime]);

    const summary = salesResult.rows[0];
    const durationHours = (new Date() - new Date(startTime)) / (1000 * 60 * 60);

    return {
      success: true,
      shift_id: shift.id,
      shift_type: shift.shift_type,
      start_time: startTime,
      duration_hours: durationHours.toFixed(2),
      summary: {
        total_transactions: parseInt(summary.total_transactions) || 0,
        total_amount: parseFloat(summary.total_amount) || 0,
        total_liters: parseFloat(summary.total_liters) || 0,
        cash_amount: parseFloat(summary.cash_amount) || 0,
        card_amount: parseFloat(summary.card_amount) || 0,
        upi_amount: parseFloat(summary.upi_amount) || 0
      }
    };

  } catch (error) {
    console.error('[ShiftClose] Get summary error:', error);
    return { success: false, message: error.message };
  }
}

module.exports = {
  autoCloseShift,
  getShiftSummary
};
