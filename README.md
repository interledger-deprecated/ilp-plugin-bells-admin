# ilp-plugin-bells

> ILP ledger plugin for [five-bells-ledger](https://github.com/interledgerjs/five-bells-ledger)

## Installation

``` sh
npm install --save ilp ilp-plugin-bells
```

## Usage

``` js
const Client = require('ilp').Client

const client = new Client({
  type: 'bells',
  auth: {
    prefix: 'ilpdemo.red.',
    // Account URI
    account: 'https://red.ilpdemo.org/ledger/accounts/alice',
    password: 'alice'
  }
})
```
