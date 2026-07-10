const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

let pool;
let poolPromise;

async function getPool() {
  if (!pool) {
    if (!poolPromise) {
      poolPromise = initDatabase().catch(err => {
        poolPromise = null;
        throw err;
      });
    }
    await poolPromise;
  }
  return pool;
}

async function initDatabase() {
  const dbName = process.env.DB_NAME || 'temple';
  const connectionConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'root',
    port: parseInt(process.env.DB_PORT || '3306', 10),
  };

  let tempPool;

  try {
    const isLocal = connectionConfig.host === 'localhost' || connectionConfig.host === '127.0.0.1';

    if (isLocal) {
      try {
        // Connect to MySQL server without database first to create it
        const connection = await mysql.createConnection(connectionConfig);
        // Create database if not exists
        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
        await connection.end();
      } catch (dbCreateError) {
        console.warn('Failed to ensure database exists, attempting direct connection:', dbCreateError.message);
      }
    }

    // Now create the pool with the database specified
    tempPool = mysql.createPool({
      ...connectionConfig,
      database: dbName,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });

    console.log(`Connected to MySQL database: ${dbName}`);

    // Check if tables exist
    const [rows] = await tempPool.query(
      `SELECT COUNT(*) as tableCount FROM information_schema.tables WHERE table_schema = ?`,
      [dbName]
    );

    const tableCount = rows[0].tableCount;
    if (tableCount === 0) {
      console.log('Database tables not found. Seeding from SQL dump...');
      await seedFromSQL(tempPool, dbName);
    } else {
      console.log(`Database already initialized with ${tableCount} tables.`);
    }

    // Only assign to global pool when everything is fully ready!
    pool = tempPool;

  } catch (error) {
    console.error('Failed to initialize database:', error.message);
    if (tempPool) {
      await tempPool.end().catch(() => {});
    }
    throw error;
  }
}

async function seedFromSQL(activePool, dbName) {
  const sqlFile = path.join(__dirname, '..', 'database', 'temple (1).sql');
  if (!fs.existsSync(sqlFile)) {
    console.error(`SQL dump file not found at: ${sqlFile}`);
    return;
  }

  const content = fs.readFileSync(sqlFile, 'utf8');
  
  // A clean parser to split by semicolon, ignoring semicolons inside strings/comments
  const queries = [];
  let currentQuery = '';
  let inString = false;
  let quoteChar = '';
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1] || '';

    // Handle block comments
    if (inBlockComment) {
      if (char === '*' && nextChar === '/') {
        inBlockComment = false;
        i++; // skip /
      }
      continue;
    }
    if (!inString && !inLineComment && char === '/' && nextChar === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    // Handle line comments
    if (inLineComment) {
      if (char === '\n' || char === '\r') {
        inLineComment = false;
      }
      continue;
    }
    if (!inString && ((char === '-' && nextChar === '-') || char === '#')) {
      inLineComment = true;
      continue;
    }

    // Handle strings
    if (inString) {
      if (char === quoteChar && content[i - 1] !== '\\') {
        inString = false;
      }
      currentQuery += char;
    } else {
      if (char === "'" || char === '"') {
        inString = true;
        quoteChar = char;
        currentQuery += char;
      } else if (char === ';') {
        if (currentQuery.trim()) {
          queries.push(currentQuery.trim());
        }
        currentQuery = '';
      } else {
        currentQuery += char;
      }
    }
  }

  if (currentQuery.trim()) {
    queries.push(currentQuery.trim());
  }

  // Execute all queries sequentially
  const conn = await activePool.getConnection();
  try {
    await conn.beginTransaction();
    // Disable foreign keys temporarily during seeding
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');

    for (const query of queries) {
      if (query.toUpperCase().startsWith('DROP TABLE') || 
          query.toUpperCase().startsWith('CREATE TABLE') || 
          query.toUpperCase().startsWith('INSERT INTO')) {
        try {
          await conn.query(query);
        } catch (err) {
          console.error(`Failed executing SQL: ${query.substring(0, 100)}...`, err.message);
        }
      }
    }

    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    await conn.commit();
    console.log('Database seeded successfully from SQL dump.');
  } catch (error) {
    await conn.rollback();
    console.error('Seeding transaction failed:', error.message);
  } finally {
    conn.release();
  }
}

module.exports = {
  // A wrapper helper to execute queries
  query: async (sql, params) => {
    const activePool = await getPool();
    return activePool.query(sql, params);
  },
  execute: async (sql, params) => {
    const activePool = await getPool();
    return activePool.execute(sql, params);
  },
  getConnection: async () => {
    const activePool = await getPool();
    return activePool.getConnection();
  }
};
