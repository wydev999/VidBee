'use strict'
const Database = require('better-sqlite3')
const db = new Database(':memory:')
db.close()
