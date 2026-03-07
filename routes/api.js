'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const db = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const router = express.Router();
router.use(authenticate);

// ── TANKS ─────────────────────────────────────────────────────────────────
router.get('/tanks', async (req, res) => {
  const data = await db.all(`SELECT t.*,(SELECT COUNT(*) FROM nozzles WHERE tank_id=t.id AND is_active=1) as nozzle_count FROM tanks t WHERE t.station_id=? ORDER BY t.fuel_type`, [req.user.stationId]);
  res.json({ success: true, data });
});

router.post('/tanks/dip-reading', authorize('owner','manager'), async (req, res) => {
  const { tankId, calculatedLitres, dipMm, notes } = req.body;
  const tank = await db.get('SELECT * FROM tanks WHERE id=? AND station_id=?', [tankId, req.user.stationId]);
  if (!tank) return res.status(404).json({ success: false, error: 'Tank not found.' });
  const variance = calculatedLitres - tank.current_stock;
  await db.run(`INSERT INTO dip_readings (station_id,tank_id,dip_mm,calculated_litres,actual_stock,variance,taken_by,notes) VALUES (?,?,?,?,?,?,?,?)`,
    [req.user.stationId, tankId, dipMm||null, calculatedLitres, calculatedLitres, variance, req.user.id, notes||null]);
  await db.run(`UPDATE tanks SET current_stock=?,updated_at=datetime('now') WHERE id=?`, [calculatedLitres, tankId]);
  res.json({ success: true, message: 'Dip reading saved.', variance });
});

// ── PURCHASES ─────────────────────────────────────────────────────────────
router.get('/purchases', async (req, res) => {
  const data = await db.all(`SELECT p.*,t.tank_name,t.fuel_type,s.name as supplier_name FROM purchases p LEFT JOIN tanks t ON t.id=p.tank_id LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.station_id=? ORDER BY p.purchase_date DESC LIMIT 50`, [req.user.stationId]);
  res.json({ success: true, data });
});

router.get('/purchases/suppliers', async (req, res) => {
  const data = await db.all('SELECT * FROM suppliers WHERE station_id=? AND is_active=1', [req.user.stationId]);
  res.json({ success: true, data });
});

router.post('/purchases', authorize('owner','manager'), async (req, res) => {
  const { tankId, supplierId, quantity, rate, invoiceNo, purchaseDate, density } = req.body;
  const tank = await db.get('SELECT id FROM tanks WHERE id=? AND station_id=?', [tankId, req.user.stationId]);
  if (!tank) return res.status(404).json({ success: false, error: 'Tank not found.' });
  const amount = +(quantity * rate).toFixed(2);
  await db.transaction(async t => {
    await t.run(`INSERT INTO purchases (station_id,tank_id,supplier_id,invoice_no,quantity,rate,amount,total_amount,density,purchase_date,received_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [req.user.stationId, tankId, supplierId||null, invoiceNo||null, quantity, rate, amount, amount, density||null, purchaseDate||new Date().toISOString().slice(0,10), req.user.id]);
    await t.run(`UPDATE tanks SET current_stock=current_stock+?,updated_at=datetime('now') WHERE id=?`, [quantity, tankId]);
  });
  res.status(201).json({ success: true, message: 'Purchase recorded.' });
});

// ── EMPLOYEES ─────────────────────────────────────────────────────────────
router.get('/employees', async (req, res) => {
  const data = await db.all('SELECT * FROM employees WHERE station_id=? AND is_active=1 ORDER BY full_name', [req.user.stationId]);
  res.json({ success: true, data });
});

router.post('/employees', authorize('owner','manager'), [
  body('fullName').trim().notEmpty().escape(),
  body('role').notEmpty().escape(),
  body('salary').optional().isFloat({min:0})
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  const { fullName, role, mobile, salary, joinDate, empCode } = req.body;
  await db.run('INSERT INTO employees (station_id,full_name,role,mobile,salary,join_date,emp_code) VALUES (?,?,?,?,?,?,?)',
    [req.user.stationId, fullName, role, mobile||null, salary||0, joinDate||null, empCode||null]);
  res.status(201).json({ success: true, message: 'Employee added.' });
});

// ── CREDIT CUSTOMERS ──────────────────────────────────────────────────────
router.get('/customers', async (req, res) => {
  const data = await db.all('SELECT * FROM credit_customers WHERE station_id=? AND is_active=1 ORDER BY company_name', [req.user.stationId]);
  res.json({ success: true, data });
});

router.post('/customers', authorize('owner','manager'), [
  body('companyName').trim().notEmpty().escape(),
  body('creditLimit').isFloat({min:0})
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  const { companyName, contactName, mobile, email, gstin, creditLimit } = req.body;
  await db.run('INSERT INTO credit_customers (station_id,company_name,contact_name,mobile,email,gstin,credit_limit) VALUES (?,?,?,?,?,?,?)',
    [req.user.stationId, companyName, contactName||null, mobile||null, email||null, gstin||null, creditLimit]);
  res.status(201).json({ success: true, message: 'Customer added.' });
});

router.get('/customers/:id/statement', async (req, res) => {
  const cust = await db.get('SELECT * FROM credit_customers WHERE id=? AND station_id=?', [req.params.id, req.user.stationId]);
  if (!cust) return res.status(404).json({ success: false, error: 'Customer not found.' });
  const sales = await db.all(`SELECT sale_time,invoice_no,fuel_type,quantity,total_amount FROM sales WHERE customer_id=? AND station_id=? AND is_cancelled=0 ORDER BY sale_time DESC LIMIT 100`, [req.params.id, req.user.stationId]);
  const payments = await db.all('SELECT payment_date,amount,payment_mode,reference_no FROM credit_payments WHERE customer_id=? AND station_id=? ORDER BY payment_date DESC LIMIT 100', [req.params.id, req.user.stationId]);
  res.json({ success: true, data: { customer: cust, sales, payments } });
});

router.post('/customers/:id/payment', authorize('owner','manager'), async (req, res) => {
  const { amount, paymentMode, referenceNo } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ success: false, error: 'Invalid amount.' });
  const cust = await db.get('SELECT * FROM credit_customers WHERE id=? AND station_id=?', [req.params.id, req.user.stationId]);
  if (!cust) return res.status(404).json({ success: false, error: 'Customer not found.' });
  await db.transaction(async t => {
    await t.run('INSERT INTO credit_payments (station_id,customer_id,amount,payment_mode,reference_no,received_by) VALUES (?,?,?,?,?,?)',
      [req.user.stationId, req.params.id, amount, paymentMode||'cash', referenceNo||null, req.user.id]);
    await t.run(`UPDATE credit_customers SET outstanding=MAX(0,outstanding-?),updated_at=datetime('now') WHERE id=?`, [amount, req.params.id]);
  });
  res.json({ success: true, message: 'Payment recorded.' });
});

// ── DASHBOARD ─────────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  const sid = req.user.stationId;
  const today = new Date().toISOString().slice(0,10);
  const [todaySales, todayRevenue, topPayments, tanks, openShift, topCredit, weekTrend, recentSales] = await Promise.all([
    db.get(`SELECT COUNT(*) as c FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0`, [sid, today]),
    db.get(`SELECT COALESCE(SUM(total_amount),0) as r FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0`, [sid, today]),
    db.all(`SELECT payment_mode, COALESCE(SUM(total_amount),0) as amount FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0 GROUP BY payment_mode`, [sid, today]),
    db.all('SELECT id,tank_name,fuel_type,current_stock,capacity,min_alert FROM tanks WHERE station_id=? AND is_active=1', [sid]),
    db.get(`SELECT sh.*,u.full_name as opened_by_name FROM shifts sh LEFT JOIN users u ON u.id=sh.opened_by WHERE sh.station_id=? AND sh.status='open' LIMIT 1`, [sid]),
    db.all('SELECT company_name,outstanding FROM credit_customers WHERE station_id=? AND outstanding>0 AND is_active=1 ORDER BY outstanding DESC LIMIT 5', [sid]),
    db.all(`SELECT date(sale_time) as d, COALESCE(SUM(total_amount),0) as rev FROM sales WHERE station_id=? AND date(sale_time)>=date('now','-6 days') AND is_cancelled=0 GROUP BY d ORDER BY d`, [sid]),
    db.all(`SELECT invoice_no,fuel_type,quantity,total_amount,payment_mode,sale_time FROM sales WHERE station_id=? AND is_cancelled=0 ORDER BY sale_time DESC LIMIT 10`, [sid])
  ]);
  res.json({ success: true, data: { todaySales: todaySales.c, todayRevenue: todayRevenue.r, topPayments, tanks, openShift, topCredit, weekTrend, recentSales } });
});

// ── REPORTS ───────────────────────────────────────────────────────────────
router.get('/reports/daily', async (req, res) => {
  const sid = req.user.stationId;
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const [fuelWise, paymentWise, shiftWise, hourly] = await Promise.all([
    db.all(`SELECT fuel_type,COUNT(*) as txns,SUM(quantity) as qty,SUM(total_amount) as amount FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0 GROUP BY fuel_type`, [sid,date]),
    db.all(`SELECT payment_mode,COUNT(*) as txns,SUM(total_amount) as amount FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0 GROUP BY payment_mode`, [sid,date]),
    db.all(`SELECT sh.shift_name,sh.open_time,sh.close_time,sh.total_sales,sh.cash_collected,sh.upi_collected,sh.card_collected,sh.credit_sales,sh.cash_physical,sh.cash_variance FROM shifts sh WHERE sh.station_id=? AND date(sh.open_time)=?`, [sid,date]),
    db.all(`SELECT strftime('%H',sale_time) as hr,COUNT(*) as txns,SUM(total_amount) as amount FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0 GROUP BY hr ORDER BY hr`, [sid,date])
  ]);
  res.json({ success: true, data: { date, fuelWise, paymentWise, shiftWise, hourly } });
});

router.get('/reports/stock', async (req, res) => {
  const sid = req.user.stationId;
  const tanks = await db.all('SELECT t.*,(SELECT quantity FROM purchases WHERE tank_id=t.id ORDER BY created_at DESC LIMIT 1) as last_purchase_qty FROM tanks t WHERE t.station_id=? AND t.is_active=1', [sid]);
  const recent = await db.all(`SELECT p.*,t.tank_name,t.fuel_type,s.name as supplier_name FROM purchases p LEFT JOIN tanks t ON t.id=p.tank_id LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.station_id=? ORDER BY p.purchase_date DESC LIMIT 20`, [sid]);
  res.json({ success: true, data: { tanks, recentPurchases: recent } });
});

router.get('/reports/upi', async (req, res) => {
  const sid = req.user.stationId;
  const { from, to } = req.query;
  const dateFrom = from || new Date().toISOString().slice(0,10);
  const dateTo = to || dateFrom;
  const data = await db.all(`SELECT payment_mode,COUNT(*) as txns,SUM(total_amount) as amount FROM sales WHERE station_id=? AND date(sale_time) BETWEEN ? AND ? AND payment_mode IN ('phonepe','gpay','paytm') AND is_cancelled=0 GROUP BY payment_mode`, [sid, dateFrom, dateTo]);
  res.json({ success: true, data });
});

router.get('/reports/outstanding', async (req, res) => {
  const data = await db.all('SELECT company_name,contact_name,mobile,outstanding,credit_limit FROM credit_customers WHERE station_id=? AND outstanding>0 AND is_active=1 ORDER BY outstanding DESC', [req.user.stationId]);
  res.json({ success: true, data });
});

// ── SETTINGS ──────────────────────────────────────────────────────────────
router.get('/settings', async (req, res) => {
  const station = await db.get('SELECT * FROM stations WHERE id=?', [req.user.stationId]);
  res.json({ success: true, data: station });
});

router.put('/settings', authorize('owner'), async (req, res) => {
  const { stationName, msPrice, hsdPrice, cngPrice, idleTimeout, gstin, address, mobile, email } = req.body;
  await db.run(`UPDATE stations SET station_name=COALESCE(?,station_name),ms_price=COALESCE(?,ms_price),hsd_price=COALESCE(?,hsd_price),cng_price=COALESCE(?,cng_price),idle_timeout=COALESCE(?,idle_timeout),gstin=COALESCE(?,gstin),address=COALESCE(?,address),mobile=COALESCE(?,mobile),email=COALESCE(?,email),updated_at=datetime('now') WHERE id=?`,
    [stationName||null, msPrice||null, hsdPrice||null, cngPrice||null, idleTimeout||null, gstin||null, address||null, mobile||null, email||null, req.user.stationId]);
  res.json({ success: true, message: 'Settings updated.' });
});

router.get('/settings/users', authorize('owner'), async (req, res) => {
  const data = await db.all('SELECT id,username,full_name,role,mobile,is_active,last_login FROM users WHERE station_id=? ORDER BY role,username', [req.user.stationId]);
  res.json({ success: true, data });
});

router.post('/settings/users', authorize('owner'), [
  body('username').trim().notEmpty().isLength({min:4,max:30}).escape(),
  body('password').isLength({min:8}).matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])/),
  body('fullName').trim().notEmpty().escape(),
  body('role').isIn(['manager','cashier','attendant'])
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  const { username, password, fullName, role, mobile } = req.body;
  const exists = await db.get('SELECT id FROM users WHERE station_id=? AND username=? COLLATE NOCASE', [req.user.stationId, username]);
  if (exists) return res.status(409).json({ success: false, error: 'Username already exists.' });
  await db.run('INSERT INTO users (station_id,username,password_hash,full_name,role,mobile) VALUES (?,?,?,?,?,?)',
    [req.user.stationId, username, bcrypt.hashSync(password,12), fullName, role, mobile||null]);
  res.status(201).json({ success: true, message: 'User created.' });
});

router.get('/settings/audit', authorize('owner','manager'), async (req, res) => {
  const data = await db.all('SELECT * FROM audit_log WHERE station_id=? ORDER BY created_at DESC LIMIT 100', [req.user.stationId]);
  res.json({ success: true, data });
});

module.exports = router;

// ── SPRINT 1: Enhanced Reports ────────────────────────────────────────────

// Stock Movement: opening → purchases → sales → closing per tank per date range
router.get('/reports/stock-movement', async (req, res) => {
  const sid = req.user.stationId;
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const tanks = await db.all('SELECT * FROM tanks WHERE station_id=? AND is_active=1', [sid]);
  const movements = await Promise.all(tanks.map(async t => {
    const sales = await db.get(`SELECT COALESCE(SUM(quantity),0) as sold FROM sales WHERE station_id=? AND tank_id=? AND date(sale_time)=? AND is_cancelled=0`, [sid, t.id, date]);
    const purchases = await db.get(`SELECT COALESCE(SUM(quantity),0) as received FROM purchases WHERE station_id=? AND tank_id=? AND purchase_date=?`, [sid, t.id, date]);
    const sold = sales.sold || 0;
    const received = purchases.received || 0;
    const opening = t.current_stock + sold - received;
    const closing = t.current_stock;
    const variance = (opening + received - sold) - closing;
    return { tankId: t.id, tankName: t.tank_name, fuelType: t.fuel_type, capacity: t.capacity, opening: Math.max(0, opening), received, sold, closing, variance };
  }));
  res.json({ success: true, data: { date, movements } });
});

// Enhanced daily report with nozzle-wise breakdown
router.get('/reports/daily-enhanced', async (req, res) => {
  const sid = req.user.stationId;
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const [fuelWise, paymentWise, shiftWise, hourly, nozzleWise, totals] = await Promise.all([
    db.all(`SELECT fuel_type,COUNT(*) as txns,ROUND(SUM(quantity),2) as qty,ROUND(SUM(total_amount),2) as amount FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0 GROUP BY fuel_type`, [sid,date]),
    db.all(`SELECT payment_mode,COUNT(*) as txns,ROUND(SUM(total_amount),2) as amount FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0 GROUP BY payment_mode`, [sid,date]),
    db.all(`SELECT sh.shift_name,sh.open_time,sh.close_time,sh.total_sales,sh.cash_collected,sh.upi_collected,sh.card_collected,sh.credit_sales,sh.cash_physical,sh.cash_variance,u.full_name as opened_by FROM shifts sh LEFT JOIN users u ON u.id=sh.opened_by WHERE sh.station_id=? AND date(sh.open_time)=?`, [sid,date]),
    db.all(`SELECT strftime('%H',sale_time) as hr,COUNT(*) as txns,ROUND(SUM(total_amount),2) as amount FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0 GROUP BY hr ORDER BY hr`, [sid,date]),
    db.all(`SELECT n.nozzle_name,s.fuel_type,COUNT(*) as txns,ROUND(SUM(s.quantity),2) as qty,ROUND(SUM(s.total_amount),2) as amount FROM sales s LEFT JOIN nozzles n ON n.id=s.nozzle_id WHERE s.station_id=? AND date(s.sale_time)=? AND s.is_cancelled=0 GROUP BY s.nozzle_id ORDER BY n.nozzle_name`, [sid,date]),
    db.get(`SELECT COUNT(*) as txns, ROUND(SUM(total_amount),2) as revenue, ROUND(SUM(quantity),2) as litres FROM sales WHERE station_id=? AND date(sale_time)=? AND is_cancelled=0`, [sid,date])
  ]);
  res.json({ success: true, data: { date, fuelWise, paymentWise, shiftWise, hourly, nozzleWise, totals } });
});

// Credit customers with overdue info
router.get('/customers/outstanding', async (req, res) => {
  const sid = req.user.stationId;
  const data = await db.all(`
    SELECT c.*,
      (SELECT MAX(payment_date) FROM credit_payments WHERE customer_id=c.id AND station_id=c.station_id) as last_payment_date,
      (SELECT COUNT(*) FROM sales WHERE customer_id=c.id AND station_id=c.station_id AND date(sale_time)>=date('now','-30 days') AND is_cancelled=0) as sales_30d
    FROM credit_customers c
    WHERE c.station_id=? AND c.is_active=1
    ORDER BY c.outstanding DESC`, [sid]);
  const today = new Date();
  const result = data.map(c => {
    let daysOverdue = 0;
    if (c.last_payment_date) {
      daysOverdue = Math.floor((today - new Date(c.last_payment_date)) / 86400000);
    } else if (c.outstanding > 0) {
      daysOverdue = 999;
    }
    const cycleLimit = c.billing_cycle === 'weekly' ? 7 : c.billing_cycle === 'fortnightly' ? 14 : 30;
    return { ...c, daysOverdue, isOverdue: daysOverdue > cycleLimit && c.outstanding > 0, cycleLimit };
  });
  res.json({ success: true, data: result });
});

// 7-day trend for dashboard chart
router.get('/reports/trend', async (req, res) => {
  const sid = req.user.stationId;
  const [daily, fuelSplit, paymentSplit] = await Promise.all([
    db.all(`SELECT date(sale_time) as d, ROUND(SUM(total_amount),2) as rev, ROUND(SUM(quantity),2) as litres, COUNT(*) as txns FROM sales WHERE station_id=? AND date(sale_time)>=date('now','-6 days') AND is_cancelled=0 GROUP BY d ORDER BY d`, [sid]),
    db.all(`SELECT fuel_type, ROUND(SUM(total_amount),2) as amount FROM sales WHERE station_id=? AND date(sale_time)>=date('now','-6 days') AND is_cancelled=0 GROUP BY fuel_type`, [sid]),
    db.all(`SELECT payment_mode, ROUND(SUM(total_amount),2) as amount FROM sales WHERE station_id=? AND date(sale_time)>=date('now','-6 days') AND is_cancelled=0 GROUP BY payment_mode`, [sid])
  ]);
  res.json({ success: true, data: { daily, fuelSplit, paymentSplit } });
});
