/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict'

const messages = require('../js/constants/messages')
const electron = require('electron')
const session = electron.session
const BrowserWindow = electron.BrowserWindow
const AppStore = require('../js/stores/appStore')
const AppConfig = require('../js/constants/appConfig')
const urlParse = require('url').parse
const getBaseDomain = require('../js/lib/baseDomain').getBaseDomain
const getSetting = require('../js/settings').getSetting
const settings = require('../js/constants/settings')
const ipcMain = electron.ipcMain
const dialog = electron.dialog

const beforeSendHeadersFilteringFns = []
const beforeRequestFilteringFns = []

const trasnparent1PxGif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

// Third party domains that require a valid referer to work
const refererExceptions = ['use.typekit.net', 'cloud.typography.com']

module.exports.registerBeforeSendHeadersFilteringCB = filteringFn => {
  beforeSendHeadersFilteringFns.push(filteringFn)
}

module.exports.registerBeforeRequestFilteringCB = filteringFn => {
  beforeRequestFilteringFns.push(filteringFn)
}

/**
 * Register for notifications for webRequest.onBeforeRequest for a particular
 * session.
 * @param {object} session Session to add webRequest filtering on
 */
function registerForBeforeRequest (session) {
  session.webRequest.onBeforeRequest(function (details, cb) {
    // Using an electron binary which isn't from Brave
    if (!details.firstPartyUrl) {
      cb({})
      return
    }

    let redirectURL
    for (let i = 0; i < beforeRequestFilteringFns.length; i++) {
      let results = beforeRequestFilteringFns[i](details)
      if (!module.exports.isResourceEnabled(results.resourceName)) {
        continue
      }
      if (results.cancel) {
        // We have no good way of knowing which BrowserWindow the blocking is for
        // yet so send it everywhere and let listeners decide how to respond.
        BrowserWindow.getAllWindows().forEach(wnd =>
          wnd.webContents.send(messages.BLOCKED_RESOURCE, results.resourceName, details))
        if (details.resourceType === 'image') {
          cb({ redirectURL: trasnparent1PxGif })
        } else {
          cb({ cancel: true })
        }
        return
      }
      if (results.redirectURL) {
        redirectURL = results.redirectURL
      }
    }
    cb({redirectURL: redirectURL})
  })
}

/**
 * Register for notifications for webRequest.onBeforeSendHeaders for
 * a particular session.
 * @param {object} The session to add webRequest filtering on
 */
function registerForBeforeSendHeaders (session) {
  // For efficiency, avoid calculating sendDNT on every request. This means the
  // browser must be restarted for changes to take effect.
  const sendDNT = getSetting(settings.DO_NOT_TRACK)
  let spoofedUserAgent
  const braveRegex = new RegExp('brave/.+? ', 'gi')

  session.webRequest.onBeforeSendHeaders(function (details, cb) {
    let requestHeaders = details.requestHeaders

    // To minimize fingerprintability, remove Brave from the UA string.
    // This can be removed once https://github.com/atom/electron/issues/3602 is
    // resolved
    spoofedUserAgent = spoofedUserAgent || requestHeaders['User-Agent'].replace(braveRegex, '')
    requestHeaders['User-Agent'] = spoofedUserAgent

    // Using an electron binary which isn't from Brave
    if (!details.firstPartyUrl) {
      cb({})
      return
    }

    for (let i = 0; i < beforeSendHeadersFilteringFns.length; i++) {
      let results = beforeSendHeadersFilteringFns[i](details)
      if (!module.exports.isResourceEnabled(results.resourceName)) {
        continue
      }
      if (results.cancel) {
        cb({cancel: true})
        return
      }
      if (results.customCookie) {
        requestHeaders.Cookie = results.customCookie
      }
    }

    let hostname = urlParse(details.url || '').hostname
    if (module.exports.isResourceEnabled(AppConfig.resourceNames.COOKIEBLOCK) &&
        module.exports.isThirdPartyHost(urlParse(details.firstPartyUrl || '').hostname,
                                        hostname)) {
      // Clear cookie and referer on third-party requests
      if (requestHeaders['Cookie']) {
        requestHeaders['Cookie'] = undefined
      }
      if (requestHeaders['Referer']) {
        requestHeaders['Referer'] = refererExceptions.includes(hostname) ? 'http://localhost' : undefined
      }
    }
    if (sendDNT) {
      requestHeaders['DNT'] = '1'
    }

    cb({ requestHeaders })
  })
}

/**
 * Register permission request handler
 * @param {Object} session to add permission request handler on
 */
function registerPermissionHandler (session) {
  // Keep track of per-site permissions granted for this session.
  // TODO: Localize strings
  let permissions = {
    media: {
      action: 'use your camera and/or microphone',
      hosts: {}
    },
    geolocation: {
      action: 'see your location',
      hosts: {}
    },
    notifications: {
      action: 'show you notifications',
      hosts: {}
    },
    midiSysex: {
      action: 'use web MIDI',
      hosts: {}
    },
    pointerLock: {
      action: 'disable your mouse cursor',
      hosts: {}
    },
    fullscreen: {
      action: 'be fullscreen',
      hosts: {}
    }
  }
  session.setPermissionRequestHandler((webContents, permission, cb) => {
    let host = urlParse(webContents.getURL()).host
    let isAllowed = permissions[permission].hosts[host]
    if (isAllowed !== undefined) {
      cb(isAllowed)
    } else {
      // TODO: Add option to remember decision between restarts.
      let result = dialog.showMessageBox({
        type: 'question',
        message: host + ' is requesting permission to ' + permissions[permission].action,
        buttons: ['Deny', 'Allow'],
        defaultId: 0,
        cancelId: 0
      })
      let isTemp = dialog.showMessageBox({
        type: 'question',
        title: 'Remember this decision?',
        message: 'Would you like to remember this decision on ' + host + ' until Brave closes?',
        buttons: ['Yes', 'No'],
        defaultId: 0,
        cancelId: 0
      })
      result = !!(result)
      cb(result)
      if (!isTemp) {
        permissions[permission].hosts[host] = result
      }
    }
  })
}

module.exports.isThirdPartyHost = (baseContextHost, testHost) => {
  // TODO: Always return true if these are IP addresses that aren't the same
  if (!testHost || !baseContextHost) {
    return true
  }
  const documentDomain = getBaseDomain(baseContextHost)
  if (testHost.length > documentDomain.length) {
    return (testHost.substr(testHost.length - documentDomain.length - 1) !== '.' + documentDomain)
  } else {
    return (testHost !== documentDomain)
  }
}

function initForPartition (partition) {
  [registerPermissionHandler, registerForBeforeRequest, registerForBeforeSendHeaders].forEach(fn => {
    fn(session.fromPartition(partition))
  })
}

module.exports.init = () => {
  ['', 'private-1', 'main-1'].forEach(partition => {
    initForPartition(partition)
  })
  let initializedPartitions = {}
  ipcMain.on(messages.INITIALIZE_PARTITION, (e, partition) => {
    if (initializedPartitions[partition]) {
      return
    }
    initForPartition(partition)
    initializedPartitions[partition] = true
  })
}

module.exports.isResourceEnabled = (resourceName) => {
  const enabledFromState = AppStore.getState().getIn([resourceName, 'enabled'])
  if (enabledFromState === undefined) {
    return AppConfig[resourceName].enabled
  }
  return enabledFromState
}
