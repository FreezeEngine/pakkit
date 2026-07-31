'use strict'

if (typeof globalThis.fetch !== 'function') {
  const electronFetch = require('electron-fetch')

  globalThis.fetch = electronFetch.default || electronFetch
}