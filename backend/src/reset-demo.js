import 'dotenv/config';
import { pool, query, initDb } from './db.js';
try {
  // Drops tables left over from the old order/delivery version of this project, and clears saved conversations.
  await query('DROP TABLE IF EXISTS audit_log, calls, jobs, support_tickets, delivery_slots, orders, customers CASCADE');
  await initDb();
  await query('TRUNCATE TABLE conversations');
  console.log('Saved conversations cleared and legacy order/delivery tables removed.');
} catch (error) {
  console.error('Could not reset data:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
