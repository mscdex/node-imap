/*jslint indent: 4, node: true */

// adapted from https://github.com/andris9/inbox/blob/master/lib/xoauth.js
// this module is inspired by xoauth.py
// http://code.google.com/p/google-mail-xoauth-tools/

var crypto = require("crypto");

// Helper functions

function escapeAndJoin(arr) {
    "use strict";
    return arr.map(encodeURIComponent).join("&");
}

function hmacSha1(str, key) {
    "use strict";
    var hmac = crypto.createHmac("sha1", key);
    hmac.update(str);
    return hmac.digest("base64");
}

function initOAuthParams(options) {
    "use strict";
    return {
        oauth_consumer_key: options.consumerKey || "anonymous",
        oauth_nonce: options.nonce || String(Date.now() + Math.round(Math.random() * 1000000)),
        oauth_signature_method: "HMAC-SHA1",
        oauth_version: "1.0",
        oauth_timestamp: options.timestamp || String(Math.round(Date.now() / 1000))
    };
}

function generateOAuthBaseStr(method, requestUrl, params) {
    "use strict";
    var reqArr = [method, requestUrl].concat(Object.keys(params).sort().map(function (key) {
            return key + "=" + encodeURIComponent(params[key]);
        }).join("&"));
    return escapeAndJoin(reqArr);
}

/**
 * Generate a XOAuth login token
 * 
 * @return {String|undefined} 
 */
function generateXOAuthStr(options) {
    "use strict";
    options = options || {};

    var params = initOAuthParams(options),
        requestUrl = options.requestUrl || "https://mail.google.com/mail/b/" + (options.user || "") + "/imap/",
        baseStr,
        signatureKey,
        paramsStr,
        returnStr;

    if (options.token && !options.requestorId) {
        params.oauth_token = options.token;
    }

    baseStr = generateOAuthBaseStr(options.method || "GET", requestUrl, params);

    if (options.requestorId) {
        baseStr += encodeURIComponent("&xoauth_requestor_id=" + encodeURIComponent(options.requestorId));
    }

    signatureKey = escapeAndJoin([options.consumerSecret || "anonymous", options.tokenSecret || ""]);

    params.oauth_signature = hmacSha1(baseStr, signatureKey);

    paramsStr = Object.keys(params).sort().map(function (key) {
        return key + "=\"" + encodeURIComponent(params[key]) + "\"";
    }).join(",");

    returnStr = [options.method || "GET", requestUrl +
            (options.requestorId ? "?xoauth_requestor_id=" + encodeURIComponent(options.requestorId) : ""), paramsStr].join(" ");

    return new Buffer(returnStr, "utf-8").toString("base64");
}

/**
 * Create a XOAUTH login token generator
 * 
 * @constructor
 * @memberOf xoauth
 * @param {Object} options
 * @param {String} [options.consumerKey="anonymous"] OAuth consumer key
 * @param {String} [options.consumerSecret="anonymous"] OAuth consumer secret
 * @param {String} [options.requestorId] 2 legged OAuth requestor ID
 * @param {String} [options.nonce] Nonce value to be used for OAuth
 * @param {Number} [options.timestamp] Unix timestamp value to be used for OAuth
 * @param {String} options.user Username
 * @param {String} [options.requestUrl] OAuth request URL
 * @param {String} [options.method="GET"] OAuth request method
 * @param {String} options.token OAuth token
 * @param {String} options.tokenSecret OAuth token secret
 */
function XOAuthGenerator(options, callback) {
    "use strict";
    this.options = options || {};
    return generateXOAuthStr(this.options);
}

/**
 * Expose to the world
 * @namespace xoauth
 */
module.exports.XOAuthGenerator = XOAuthGenerator;


