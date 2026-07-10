const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(morgan('dev'));

app.get('/', (req, res) => res.send('TempleBill API is running'));

// --- Login API ---
app.post('/api/login', async (req, res) => {
  const { username, phonenumber, password } = req.body;
  const loginIdentifier = phonenumber || username;
  try {
    const [users] = await db.query(
      'SELECT * FROM company WHERE (PhoneNumber = ? OR UserName = ?) AND IsActive = 1',
      [loginIdentifier, loginIdentifier]
    );
    if (users.length === 0) return res.status(401).json({ error: 'User not found' });

    const user = users[0];
    const valid = bcrypt.compareSync(password, user.PasswordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid password' });

    const { PasswordHash, RefreshToken, ...userData } = user;
    res.json({ message: 'Login successful', user: userData });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Dashboard Stats ---
app.get('/api/dashboard', async (req, res) => {
  try {
    const [incomeRows] = await db.query('SELECT SUM(Amount) as total FROM transactions WHERE TransactionType = 1 AND IsActive = 1');
    const [expenseRows] = await db.query('SELECT SUM(Amount) as total FROM transactions WHERE TransactionType = 2 AND IsActive = 1');
    
    const totalIncome = parseFloat(incomeRows[0].total) || 0;
    const totalExpense = parseFloat(expenseRows[0].total) || 0;
    const balance = totalIncome - totalExpense;
    
        const [recentTransactions] = await db.query(`
      SELECT t.*, c.CategoryName, u.UserName as EnteredByName, u2.UserName as InchargeName, u3.UserName as NameName
      FROM transactions t 
      LEFT JOIN categories c ON t.CategoryId = c.CategoryId 
      LEFT JOIN company u ON t.EnteredById = u.UserId
      LEFT JOIN company u2 ON t.InchargeId = u2.UserId
      LEFT JOIN company u3 ON t.NameId = u3.UserId
      WHERE t.IsActive = 1 
      ORDER BY t.DateTime DESC LIMIT 10
    `);

    res.json({
      stats: { totalIncome, totalExpense, balance },
      recentTransactions
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- All Transactions ---
app.get('/api/transactions', async (req, res) => {
  try {
    const [transactions] = await db.query(`
      SELECT t.*, c.CategoryName, u.UserName as EnteredByName, u2.UserName as InchargeName, u3.UserName as NameName
      FROM transactions t 
      LEFT JOIN categories c ON t.CategoryId = c.CategoryId 
      LEFT JOIN company u ON t.EnteredById = u.UserId
      LEFT JOIN company u2 ON t.InchargeId = u2.UserId
      LEFT JOIN company u3 ON t.NameId = u3.UserId
      WHERE t.IsActive = 1 
      ORDER BY t.DateTime DESC
    `);
    
    // Group by date for report
    const grouped = transactions.reduce((acc, tx) => {
      if (!tx.DateTime) return acc;
      // Format date part
      const date = tx.DateTime instanceof Date 
        ? tx.DateTime.toISOString().split('T')[0] 
        : String(tx.DateTime).split(' ')[0];
      if (!acc[date]) acc[date] = [];
      acc[date].push(tx);
      return acc;
    }, {});

    res.json({ transactions, grouped });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create Transaction
app.post('/api/transactions', async (req, res) => {
  const { NameId, InchargeId, Amount, description, CategoryId, PaymentType, TransactionType, EnteredById } = req.body;
  try {
    const TrasId = crypto.randomUUID();
    await db.query(
      `INSERT INTO transactions (TrasId, NameId, InchargeId, Amount, description, CategoryId, PaymentType, TransactionType, EnteredById, DateTime, IsActive)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 1)`,
      [TrasId, NameId, InchargeId, Amount, description || null, CategoryId || null, PaymentType, TransactionType, EnteredById]
    );
    res.json({ success: true, TrasId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Transaction
app.put('/api/transactions/:id', async (req, res) => {
  const { id } = req.params;
  const { NameId, InchargeId, Amount, description, CategoryId, PaymentType, TransactionType } = req.body;
  try {
    await db.query(
      `UPDATE transactions 
       SET NameId = ?, InchargeId = ?, Amount = ?, description = ?, CategoryId = ?, PaymentType = ?, TransactionType = ?
       WHERE TrasId = ?`,
      [NameId, InchargeId, Amount, description || null, CategoryId || null, PaymentType, TransactionType, id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete Transaction
app.delete('/api/transactions/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('UPDATE transactions SET IsActive = 0 WHERE TrasId = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Categories API ---
app.get('/api/categories', async (req, res) => {
  try {
    const [categories] = await db.query('SELECT * FROM categories WHERE IsActive = 1 ORDER BY Date DESC');
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/categories', async (req, res) => {
  const { CategoryName, CategoryType, UserId } = req.body;
  try {
    const CategoryId = crypto.randomUUID();
    await db.query(
      `INSERT INTO categories (CategoryId, CategoryName, CategoryType, UserId, Date, IsActive)
       VALUES (?, ?, ?, ?, NOW(), 1)`,
      [CategoryId, CategoryName, CategoryType ?? 1, UserId || 'admin']
    );
    res.json({ success: true, CategoryId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/categories/:id', async (req, res) => {
  const { id } = req.params;
  const { CategoryName, CategoryType } = req.body;
  try {
    await db.query(
      'UPDATE categories SET CategoryName = ?, CategoryType = ? WHERE CategoryId = ?',
      [CategoryName, CategoryType, id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/categories/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('UPDATE categories SET IsActive = 0 WHERE CategoryId = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Users (Company) API ---
app.get('/api/users', async (req, res) => {
  try {
    const [users] = await db.query('SELECT UserId, FullName, PhoneNumber, UserName, Role, IsActive FROM company WHERE IsActive = 1 ORDER BY Id DESC');
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/users', async (req, res) => {
  const { FullName, PhoneNumber, UserName, Password, Role } = req.body;
  try {
    const UserId = crypto.randomUUID();
    const salt = bcrypt.genSaltSync(11);
    const PasswordHash = bcrypt.hashSync(Password, salt);
    
    await db.query(
      `INSERT INTO company (UserId, FullName, PhoneNumber, UserName, PasswordHash, Role, IsActive)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [UserId, FullName, PhoneNumber, UserName, PasswordHash, Role]
    );
    res.json({ success: true, UserId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  const { FullName, PhoneNumber, UserName, Password, Role } = req.body;
  try {
    if (Password && Password.trim()) {
      const salt = bcrypt.genSaltSync(11);
      const PasswordHash = bcrypt.hashSync(Password, salt);
      await db.query(
        `UPDATE company SET FullName = ?, PhoneNumber = ?, UserName = ?, PasswordHash = ?, Role = ? WHERE UserId = ?`,
        [FullName, PhoneNumber, UserName, PasswordHash, Role, id]
      );
    } else {
      await db.query(
        `UPDATE company SET FullName = ?, PhoneNumber = ?, UserName = ?, Role = ? WHERE UserId = ?`,
        [FullName, PhoneNumber, UserName, Role, id]
      );
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('UPDATE company SET IsActive = 0 WHERE UserId = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
