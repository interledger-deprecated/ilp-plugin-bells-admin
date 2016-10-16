'use strict'

const parseURL = require('url').parse
const co = require('co')
const request = require('co-request')
const WebSocket = require('ws')
const reconnectCore = require('reconnect-core')
const debug = require('debug')('ilp-plugin-bells-admin:plugin')
const ExternalError = require('../errors/external-error')
const UnrelatedNotificationError = require('../errors/unrelated-notification-error')
const MissingFulfillmentError = require('../errors/missing-fulfillment-error')
const TransferNotFoundError = require('../errors/transfer-not-found-error')
const EventEmitter2 = require('eventemitter2').EventEmitter2
const isUndefined = require('lodash/fp/isUndefined')
const omitUndefined = require('lodash/fp/omitBy')(isUndefined)
const startsWith = require('lodash/fp/startsWith')
const find = require('lodash/find')

const backoffMin = 1000
const backoffMax = 30000

function wait (ms) {
  return function (done) {
    setTimeout(done, ms)
  }
}

function * requestRetry (opts, errorMessage, credentials) {
  let delay = backoffMin
  while (true) {
    debug('connecting to account ' + opts.uri)
    try {
      // TODO cache
      let res = yield request(Object.assign(
        {json: true},
        requestCredentials(credentials),
        opts))
      if (res.statusCode >= 400 && res.statusCode < 500) {
        debug('request status ' + res.statusCode + ' retrying connection')
        break
      }
      return res
    } catch (err) {
      debug('http request failed: ' + errorMessage)
      delay = Math.min(Math.floor(1.5 * delay), backoffMax)
      yield wait(delay)
    }
  }
  debug('http request failed. aborting.')
  throw new Error(errorMessage)
}

class FiveBellsLedgerAdmin extends EventEmitter2 {
  constructor (options) {
    super()

    if (typeof options !== 'object') {
      throw new TypeError('Expected an options object, received: ' + typeof options)
    }

    if (options.prefix && typeof options.prefix !== 'string') {
      throw new TypeError('Expected options.prefix to be a string, received: ' +
        typeof options.prefix)
    }

    if (typeof options.prefix === 'string' && options.prefix.slice(-1) !== '.') {
      throw new Error('Expected options.prefix to end with "."')
    }

    this.configPrefix = options.prefix
    this.credentials = {
      account: options.account,
      username: options.username,
      password: options.password,
      cert: options.cert,
      key: options.key,
      ca: options.ca
    }
    this.connector = options.connector || null

    this.debugReplyNotifications = options.debugReplyNotifications || false

    this.instance = options.instance || {ws: null}

    this.onWsMessage = this._onWsMessage.bind(this)
    this.onWsConnect = this._onWsConnect.bind(this)
    this.onWsDisconnect = this._onWsDisconnect.bind(this)

    this.listenersAdded = false
  }

  _onWsMessage (msg) {
    const notification = JSON.parse(msg)
    debug('notify transfer', notification.resource.state, notification.resource.id)

    co.wrap(this._handleNotification)
      .call(this, notification.resource, notification.related_resources)
      .then(() => {
        if (this.debugReplyNotifications) {
          ws.send(JSON.stringify({ result: 'processed' }))
        }
      })
      .catch((err) => {
        debug('failure while processing notification: ' +
        (err && err.stack) ? err.stack : err)
        if (this.debugReplyNotifications) {
          ws.send(JSON.stringify({
            result: 'ignored',
            ignoreReason: {
              id: err.name,
              message: err.message
            }
          }))
        }
      })
  }

  _onWsConnect () {
    debug("%o", 'websocket: connected')
    this.emit('connect')
  }

  _onWsDisconnect () {
    debug("%o", 'websocket: disconnected')
    this.disconnect()
    this.emit('disconnect')
  }

  connect () {
    if (this.connecting) {
      return this.connecting
    }

    this.connecting = co(this._connect.bind(this))
    this.connecting.then(() => {
      this.connecting = false
    })

    return this.connecting
  }

  * _connect () {
    const accountUri = this.credentials.account

    if (this.listenersAdded) {
      debug('already connected, ignoring connection request')
      return Promise.resolve(null)
    }

    // Resolve account information
    const res = yield requestRetry({
      method: 'GET',
      uri: accountUri,
      json: true
    }, 'Failed to resolve ledger URI from account URI', this.credentials)

    if (!res.body.ledger) {
      throw new Error('Failed to resolve ledger URI from account URI')
    }
    this.instance.host = res.body.ledger
    // Set the username but don't overwrite the username in case it was provided
    if (!this.credentials.username) {
      this.credentials.username = res.body.name
    }

    if (!res.body.connector && this.connector) {
      const res2 = yield this._request({
        uri: accountUri,
        method: 'put',
        body: {
          name: res.body.name,
          connector: this.connector
        }
      })

      if (!res2 || res2.statusCode !== 200) {
        throw new Error('Unable to set connector URI')
      }
    }

    // Resolve ledger metadata
    const ledgerMetadata = yield this._fetchLedgerMetadata()
    this.instance.accountUriTemplate = ledgerMetadata.urls.account

    // Set ILP prefix
    const ledgerPrefix = ledgerMetadata.ilp_prefix
    this.instance.prefix = this.configPrefix || ledgerMetadata.ilp_prefix

    if (ledgerPrefix && this.configPrefix && ledgerPrefix !== this.configPrefix) {
      console.warn('ilp-plugin-bells: ledger prefix (' + ledgerPrefix +
        ') does not match locally configured prefix (' + this.configPrefix + ')')
    }
    if (!this.instance.prefix) {
      throw new Error('Unable to set prefix from ledger or from local config')
    }

    const streamUri = accountUri.replace('http', 'ws').replace(/\/accounts\/[\w]*/, '/accounts/*') + '/transfers'
    const auth = this.credentials.password && this.credentials.username &&
      this.credentials.username + ':' + this.credentials.password
    const options = {
      headers: auth && {
        Authorization: 'Basic ' + new Buffer(auth, 'utf8').toString('base64')
      },
      cert: this.credentials.cert,
      key: this.credentials.key,
      ca: this.credentials.ca
    }

    const reconnect = reconnectCore(() =>
      new WebSocket(streamUri, omitUndefined(options)))

    this.listenersAdded = true

    return new Promise((resolve, reject) => {
      if (!this.instance.ws) {
        debug('subscribing to ' + streamUri)
        this.instance.ws = reconnect({immediate: true})
        this.instance.ws.once('connect', () => {
          this.instance.ws._connection.on('message', this.onWsMessage)
          resolve(null)
        })
      }

      this.instance.ws
        .on('connect', this.onWsConnect)
        .on('disconnect', this.onWsDisconnect)
        .on('error', (err) => {
          debug("%o", 'websocket: error', err)
          debug('ws error on ' + streamUri + ': ' + err)
          reject(err)
        })

      if (this.instance.ws.connected) {
        this.instance.ws._connection.on('message', this.onWsMessage)
        return resolve(null)
      }

      this.instance.ws.connect()
    })
  }

  disconnect () {
    this.instance.ws.removeListener('connect', this.onWsConnect)
    this.instance.ws.removeListener('disconnect', this.onWsDisconnect)
    // TODO leave at least one error handler
    this.instance.ws.removeAllListeners('error')
    this.instance.ws._connection.removeListener('message', this.onWsMessage)

    this.listenersAdded = false

    return Promise.resolve(null)
  }

  isConnected () {
    return this.instance.ws.connected
  }

  getInfo () {
    return co.wrap(this._getInfo).call(this)
  }

  * _getInfo () {
    const ledgerMetadata = yield this._fetchLedgerMetadata()

    this.instance.info = {
      connectors: ledgerMetadata.connectors,
      precision: ledgerMetadata.precision,
      scale: ledgerMetadata.scale,
      currencyCode: ledgerMetadata.currency_code,
      currencySymbol: ledgerMetadata.currency_symbol
    }
    return this.instance.info
  }

  * _fetchLedgerMetadata () {
    if (this.instance.ledgerMetadata) return this.instance.ledgerMetadata

    debug('request ledger metadata %s', this.instance.host)
    function throwErr () {
      throw new ExternalError('Unable to determine ledger precision')
    }

    let res
    try {
      res = yield request(this.instance.host, {json: true})
    } catch (e) {
      if (!res || res.statusCode !== 200) {
        debug('getInfo error %s', e)
        throwErr()
      }
    }

    if (!res || res.statusCode !== 200) throwErr()
    if (!res.body.precision || !res.body.scale) throwErr()

    this.instance.ledgerMetadata = res.body

    return res.body
  }

  getPrefix () {
    if (!this.instance.prefix) {
      return Promise.reject(new Error('Prefix has not been set'))
    }
    return Promise.resolve(this.instance.prefix)
  }

  getAccount () {
    if (!this.instance.ws.connected) {
      return Promise.reject(new Error('Must be connected before getAccount can be called'))
    }
    return Promise.resolve(this.instance.prefix + this.accountUriToName(this.credentials.account))
  }

  _validateTransfer (transfer) {
    // validator.validate('TransferTemplate', transfer)
  }

  getBalance () {
    return co.wrap(this._getBalance).call(this)
  }

  * _getBalance () {
    const creds = this.credentials
    let res
    try {
      res = yield request(Object.assign({
        method: 'get',
        uri: creds.account,
        json: true
      }, requestCredentials(creds)))
    } catch (e) { }
    if (!res || res.statusCode !== 200) {
      throw new ExternalError('Unable to determine current balance')
    }
    return res.body.balance
  }

  send (transfer) {
    return co.wrap(this._send).call(this, transfer)
  }

  * _send (transfer) {
    const sourceAddress = yield this.parseAddress(transfer.account)
    const fiveBellsTransfer = omitUndefined({
      id: this.instance.host + '/transfers/' + transfer.id,
      ledger: this.instance.host,
      debits: [omitUndefined({
        account: this.credentials.account,
        amount: transfer.amount,
        authorized: true,
        memo: transfer.noteToSelf
      })],
      credits: [omitUndefined({
        account: this.instance.host + '/accounts/' + encodeURIComponent(sourceAddress.username),
        amount: transfer.amount,
        memo: transfer.data
      })],
      execution_condition: transfer.executionCondition,
      cancellation_condition: transfer.cancellationCondition,
      expires_at: transfer.expiresAt,
      additional_info: transfer.cases ? { cases: transfer.cases } : undefined
    })

    // If Atomic mode, add destination transfer to notification targets
    if (transfer.cases) {
      for (let caseUri of transfer.cases) {
        debug('add case notification for ' + caseUri)
        const res = yield request({
          method: 'POST',
          uri: caseUri + '/targets',
          body: [ fiveBellsTransfer.id + '/fulfillment' ],
          json: true
        })

        if (res.statusCode !== 200) {
          throw new Error('Unexpected status code: ' + res.statusCode)
        }
      }
    }

    debug('submitting transfer %s', fiveBellsTransfer.id)
    yield this._request({
      method: 'put',
      uri: fiveBellsTransfer.id,
      body: fiveBellsTransfer
    })

    // TODO: If already executed, fetch fulfillment and forward to source

    return null
  }

  fulfillCondition (transferId, conditionFulfillment) {
    return co.wrap(this._fulfillCondition).call(this, transferId, conditionFulfillment)
  }

  * _fulfillCondition (transferId, conditionFulfillment) {
    const fulfillmentRes = yield this._request({
      method: 'put',
      uri: this.instance.host + '/transfers/' + transferId + '/fulfillment',
      body: conditionFulfillment,
      json: false
    })
    // TODO check the timestamp the ledger sends back
    // See https://github.com/interledgerjs/five-bells-ledger/issues/149
    if (fulfillmentRes.statusCode === 200 || fulfillmentRes.statusCode === 201) {
      return null
    } else {
      throw new Error('Failed to submit fulfillment for transfer: ' + transferId + ' Error: ' + (fulfillmentRes.body ? JSON.stringify(fulfillmentRes.body) : fulfillmentRes.error))
    }
  }

  /**
   * @param {String} transferId
   * @returns {Promise<String>}
   */
  getFulfillment (transferId) {
    return co.wrap(this._getFulfillment).call(this, transferId)
  }

  * _getFulfillment (transferId) {
    let res
    try {
      res = yield request(Object.assign({
        method: 'get',
        uri: this.instance.host + '/transfers/' + transferId + '/fulfillment',
        json: true
      }, requestCredentials(this.credentials)))
    } catch (err) {
      throw new ExternalError('Remote error: message=' + err.message)
    }

    if (res.statusCode === 200) return res.body
    if (res.statusCode === 404) {
      if (res.body.id === 'FulfillmentNotFoundError') {
        throw new MissingFulfillmentError(res.body.message)
      }
      if (res.body.id === 'TransferNotFoundError') {
        throw new TransferNotFoundError(res.body.message)
      }
    }
    throw new ExternalError('Remote error: status=' + (res && res.statusCode))
  }

  /**
   * @param {String} transferId
   * @param {String} rejectionMessage
   * @returns {Promise<null>}
   */
  rejectIncomingTransfer (transferId, rejectionMessage) {
    return co.wrap(this._rejectIncomingTransfer).call(this, transferId, rejectionMessage)
  }

  * _rejectIncomingTransfer (transferId, rejectionMessage) {
    yield this._request({
      method: 'put',
      uri: this.instance.host + '/transfers/' + transferId + '/rejection',
      body: rejectionMessage,
      json: false
    })
    return null
  }

  * _handleNotification (fiveBellsTransfer, relatedResources) {
    this._validateTransfer(fiveBellsTransfer)

    let handled = false
    for (let credit of fiveBellsTransfer.credits) {
      if (credit.account === this.credentials.account) {
        handled = true

        const transfer = omitUndefined({
          id: fiveBellsTransfer.id.substring(fiveBellsTransfer.id.length - 36),
          direction: 'incoming',
          // TODO: What if there are multiple debits?
          account: this.instance.prefix + this.accountUriToName(fiveBellsTransfer.debits[0].account),
          ledger: this.instance.prefix,
          amount: credit.amount,
          data: credit.memo,
          executionCondition: fiveBellsTransfer.execution_condition,
          cancellationCondition: fiveBellsTransfer.cancellation_condition,
          expiresAt: fiveBellsTransfer.expires_at,
          cases: fiveBellsTransfer.additional_info && fiveBellsTransfer.additional_info.cases
            ? fiveBellsTransfer.additional_info.cases
            : undefined
        })

        if (fiveBellsTransfer.state === 'prepared') {
          yield this.emitAsync('incoming_prepare', transfer)
        }
        if (fiveBellsTransfer.state === 'executed' && !transfer.executionCondition) {
          yield this.emitAsync('incoming_transfer', transfer)
        }

        if (fiveBellsTransfer.state === 'executed' && relatedResources &&
          relatedResources.execution_condition_fulfillment) {
          yield this.emitAsync('incoming_fulfill', transfer,
            relatedResources.execution_condition_fulfillment)
        }

        if (fiveBellsTransfer.state === 'rejected' && relatedResources &&
          relatedResources.cancellation_condition_fulfillment) {
          yield this.emitAsync('incoming_cancel', transfer,
            relatedResources.cancellation_condition_fulfillment)
        } else if (fiveBellsTransfer.state === 'rejected') {
          yield this.emitAsync('incoming_cancel', transfer, 'transfer timed out.')
        }
      }
    }

    for (let debit of fiveBellsTransfer.debits) {
      if (debit.account === this.credentials.account) {
        handled = true

        // This connector only launches transfers with one credit, so there
        // should never be more than one credit.
        const credit = fiveBellsTransfer.credits[0]
        const transfer = omitUndefined({
          id: fiveBellsTransfer.id.substring(fiveBellsTransfer.id.length - 36),
          direction: 'outgoing',
          account: this.instance.prefix + this.accountUriToName(credit.account),
          ledger: this.instance.prefix,
          amount: debit.amount,
          data: credit.memo,
          noteToSelf: debit.memo,
          executionCondition: fiveBellsTransfer.execution_condition,
          cancellationCondition: fiveBellsTransfer.cancellation_condition,
          expiresAt: fiveBellsTransfer.expires_at,
          cases: fiveBellsTransfer.additional_info && fiveBellsTransfer.additional_info.cases
            ? fiveBellsTransfer.additional_info.cases
            : undefined
        })

        if (fiveBellsTransfer.state === 'prepared') {
          yield this.emitAsync('outgoing_prepare', transfer)
        }
        if (fiveBellsTransfer.state === 'executed' && !transfer.executionCondition) {
          yield this.emitAsync('outgoing_transfer', transfer)
        }

        if (fiveBellsTransfer.state === 'executed' && relatedResources &&
          relatedResources.execution_condition_fulfillment) {
          yield this.emitAsync('outgoing_fulfill', transfer,
            relatedResources.execution_condition_fulfillment)
        }

        if (fiveBellsTransfer.state === 'rejected' && relatedResources &&
          relatedResources.cancellation_condition_fulfillment) {
          yield this.emitAsync('outgoing_cancel', transfer,
            relatedResources.cancellation_condition_fulfillment)
        } else if (fiveBellsTransfer.state === 'rejected') {
          const rejectedCredit = find(fiveBellsTransfer.credits, 'rejected')
          if (rejectedCredit) {
            yield this.emitAsync('outgoing_reject', transfer,
              new Buffer(rejectedCredit.rejection_message, 'base64').toString())
          } else {
            yield this.emitAsync('outgoing_cancel', transfer, 'transfer timed out.')
          }
        }
      }
    }
    if (!handled) {
      throw new UnrelatedNotificationError('Notification does not seem related to connector')
    }
  }

  * _request (opts) {
    // TODO: check before this point that we actually have
    // credentials for the ledgers we're asked to settle between
    const transferRes = yield request(Object.assign(
      {json: true},
      requestCredentials(this.credentials),
      opts))
    // TODO for source transfers: handle this so we actually get our money back
    if (transferRes.statusCode >= 400) {
      const error = new ExternalError('Remote error: status=' + transferRes.statusCode)
      error.status = transferRes.statusCode
      error.response = transferRes
      throw error
    }
    return transferRes
  }

  accountNameToUri (name) {
    return this.instance.accountUriTemplate.replace(':name', name)
  }

  /**
   * Get the account name from "http://red.example/accounts/alice" (where
   * accountUriTemplate is "http://red.example/accounts/:name").
   */
  accountUriToName (accountURI) {
    const templatePath = parseURL(this.instance.accountUriTemplate).path.split('/')
    const accountPath = parseURL(accountURI).path.split('/')
    for (let i = 0; i < templatePath.length; i++) {
      if (templatePath[i] === ':name') return accountPath[i]
    }
  }

  * parseAddress (address) {
    const prefix = yield this.getPrefix()

    if (!startsWith(prefix, address)) {
      debug('destination address has invalid prefix', { prefix, address })
      throw new Error('Destination address "' + address + '" must start ' +
        'with ledger prefix "' + prefix + '"')
    }

    const addressParts = address.substr(this.instance.prefix.length).split('.')
    return {
      ledger: prefix,
      username: addressParts.slice(0, 1).join('.'),
      additionalParts: addressParts.slice(1).join('.')
    }
  }
}

function requestCredentials (credentials) {
  return omitUndefined({
    auth: credentials.username && credentials.password && {
      user: credentials.username,
      pass: credentials.password
    },
    cert: credentials.cert,
    key: credentials.key,
    ca: credentials.ca
  })
}

module.exports = FiveBellsLedgerAdmin
