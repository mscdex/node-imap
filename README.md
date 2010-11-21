Description
===========

node-imap is an IMAP module for [node.js](http://nodejs.org/) that provides an asynchronous interface for communicating with an IMAP mail server.

This module does not perform any magic such as auto-decoding of messages/attachments or parsing of email addresses (node-imap leaves all mail header values as-is).
If you are in need of this kind of extra functionality, check out andris9's [mime.js](http://github.com/andris9/mailparser/blob/master/mime.js) (requires [node-iconv](http://github.com/bnoordhuis/node-iconv)) set of functions, part of his [mailparser](http://github.com/andris9/mailparser) module.


Requirements
============

* [node.js](http://nodejs.org/) -- tested with v0.2.4
* An IMAP server -- tested with gmail


Example
=======

This example fetches the 'date', 'from', 'to', 'subject' message headers and the message structure of the first message in the Inbox since May 20, 2010:

    var ImapConnection = require('./imap').ImapConnection, sys = require('sys'),
        imap = new ImapConnection({
          username: 'mygmailname@gmail.com',
          password: 'mygmailpassword',
          host: 'imap.gmail.com',
          port: 993,
          secure: true
        });

    function die(err) {
      console.log('Uh oh: ' + err);
    }

    var messages, cmds, next = 0, cb = function(err, box, result) {
      if (err)
        die(err);
      else if (next < cmds.length)
        cmds[next++](box, result);
    };
    cmds = [
      function() { imap.connect(cb); },
      function() { imap.openBox('INBOX', false, cb); },
      function() { imap.search([ ['SINCE', 'May 20, 2010'] ], cb); },
      function(box, result) { imap.fetch(result[0], { request: { headers: ['from', 'to', 'subject', 'date'] } }, cb); },
      function(box, result) { console.log(sys.inspect(result, false, 6)); imap.logout(cb); }
    ];
    cb();


API
===

node-imap exposes one object: **ImapConnection**.


#### Data types

* _Box_ is an Object representing the currently open mailbox, and has the following properties:
    * **name** - A String containing the name of this mailbox.
    * **permFlags** - An Array containing the flags that can be permanently added/removed to/from messages in this mailbox.
    * **messages** - An Object containing properties about message counts for this mailbox.
        * **total** - An Integer representing total number of messages in this mailbox.
        * **new** - An Integer representing the number of new (unread) messages in this mailbox.
* _FetchResult_ is an Object representing the result of a message fetch, and has the following properties:
    * **flags** - An Array containing the flags currently set on this message.
    * **date** - A String containing the internal server date for the message (always represented in GMT?)
    * **headers** - An Object containing the headers of the message, **if headers were requested when calling fetch().** Note: The value of each property in the object is an Array containing the value(s) for that particular header name (in case of duplicate headers).
    * **body** - A String containing the text of the entire or a portion of the message, **if a body was requested when calling fetch().**
    * **structure** - An Array containing the structure of the message, **if the structure was requested when calling fetch().** See below for an explanation of the format of this property.

A message structure with multiple parts might look something like the following:
    [ { type: 'mixed'
      , params: { boundary: '000e0cd294e80dc84c0475bf339d' }
      , disposition: null
      , language: null
      , location: null
      }
    , [ { type: 'alternative'
        , params: { boundary: '000e0cd294e80dc83c0475bf339b' }
        , disposition: null
        , language: null
        , location: null
        }
      , [ { partID: '1.1'
          , type:
             { name: 'text/plain'
             , params: { charset: 'ISO-8859-1' }
             }
          , id: null
          , description: null
          , encoding: '7BIT'
          , size: 935
          , lines: 46
          , md5: null
          , disposition: null
          , language: null
          , location: null
          }
        ]
      , [ { partID: '1.2'
          , type:
             { name: 'text/html'
             , params: { charset: 'ISO-8859-1' }
             }
          , id: null
          , description: null
          , encoding: 'QUOTED-PRINTABLE'
          , size: 1962
          , lines: 33
          , md5: null
          , disposition: null
          , language: null
          , location: null
          }
        ]
      ]
    , [ { partID: '2'
        , type:
           { name: 'application/octet-stream'
           , params: { name: 'somefile' }
           }
        , id: null
        , description: null
        , encoding: 'BASE64'
        , size: 98
        , lines: null
        , md5: null
        , disposition:
           { type: 'attachment'
           , params: { filename: 'somefile' }
           }
        , language: null
        , location: null
        }
      ]
    ]
The above structure describes a message having both an attachment and two forms of the message body (plain text and HTML).
Each message part is identified by a partID which is used when you want to fetch the content of that part (**see fetch()**).

The structure of a message with only one part will simply look something like this:
    [ { partID: '1'
        , type:
           { name: 'text/plain'
           , params: { charset: 'ISO-8859-1' }
           }
        , id: null
        , description: null
        , encoding: '7BIT'
        , size: 935
        , lines: 46
        , md5: null
        , disposition: null
        , language: null
        , location: null
      }
    ]
Therefore, an easy way to check for a multipart message is to check if the structure length is >1.

Lastly, here are the system flags defined by the IMAP spec (that may be added/removed to/from messages):

* \Seen - Message has been read
* \Answered - Message has been answered
* \Flagged - Message is "flagged" for urgent/special attention
* \Deleted - Message is "deleted" for removal
* \Draft - Message has not completed composition (marked as a draft).

It should be noted however that the IMAP server can limit which flags can be permanently modified for any given message. If in doubt, check the mailbox's **permFlags** Array first.
Additional custom flags may be provided by the server. If available, these will also be listed in the mailbox's **permFlags** Array.


ImapConnection Events
---------------------

* **alert**(String) - Fires when the server issues an alert (e.g. "the server is going down for maintenance"). The supplied String is the text of the alert message.

* **mail**(Integer) - Fires when new mail arrives in the currently open mailbox. The supplied Integer specifies the number of new messages.

* **close**(Boolean) - Fires when the connection is completely closed (similar to net.Stream's close event). The specified Boolean indicates whether the connection was terminated due to a transmission error or not.

* **end**() - Fires when the connection is ended (similar to net.Stream's end event).

* **error**(Error) - Fires when an exception/error occurs (similar to net.Stream's error event). The given Error object represents the error raised.


ImapConnection Functions
------------------------

* **(constructor)**([Object]) - _ImapConnection_ - Creates and returns a new instance of ImapConnection using the specified configuration object. Valid properties of the passed in object are:
    * **username** - A String representing the username for authentication.
    * **password** - A String representing the password for authentication.
    * **host** - A String representing the hostname or IP address of the IMAP server. **Default:** "localhost"
    * **port** - An Integer representing the port of the IMAP server. **Default:** 143
    * **secure** - A Boolean indicating the connection should use SSL/TLS. **Default:** false
    * **connTimeout** - An Integer indicating the number of milliseconds to wait for a connection to be established. **Default:** 10000

* **connect**(Function) - _(void)_ - Attempts to connect and log into the IMAP server. The Function parameter is the callback with one parameter: the error (null if none).

* **logout**(Function) - _(void)_ - Closes the connection to the server. The Function parameter is the callback.

* **openBox**(String, Boolean, Function) - _(void)_ - Opens a specific mailbox that exists on the server. The String parameter is the name of the mailbox to open. The Boolean parameter specifies whether to open the mailbox in read-only mode or not. The Function parameter is the callback with two parameters: the error (null if none), and the _Box_ object of the newly opened mailbox.

* **closeBox**(Function) - _(void)_ - Closes the currently open mailbox. **Any messages marked as \Deleted in the mailbox will be removed if the mailbox was NOT opened in read-only mode.** Also, logging out or opening another mailbox without closing the current one first will NOT cause deleted messages to be removed. The Function parameter is the callback with one parameter: the error (null if none).

* **search**(Array, Function) - _(void)_ - Searches the currently open mailbox for messages using specific criterion. The Function parameter is the callback with three parameters: the error (null if none), the _Box_ object of the currently open mailbox, and an Array containing the message IDs matching the search criterion. The Array parameter is a list of Arrays containing the criterion (and any required arguments) to be used. Prefix the criteria name with an "!" to negate. For example, to search for unread messages since April 20, 2010 you could use: [ ['UNSEEN'], ['SINCE', 'April 20, 2010'] ]. To search for messages that are EITHER unread OR are dated April 20, 2010 or later, you could use: [ ['OR', ['UNSEEN'], ['SINCE', 'April 20, 2010'] ] ].
    * The following message flags are valid criterion and do not require values:
        * 'ANSWERED' - Messages with the \Answered flag set.
        * 'DELETED' - Messages with the \Deleted flag set.
        * 'DRAFT' - Messages with the \Draft flag set.
        * 'FLAGGED' - Messages with the \Flagged flag set.
        * 'NEW' - Messages that have the \Recent flag set but not the \Seen flag.
        * 'SEEN' - Messages that have the \Seen flag set.
        * 'RECENT' - Messages that have the \Recent flag set.
        * 'OLD' - Messages that do not have the \Recent flag set. This is functionally equivalent to a criteria of "!RECENT" (as opposed to "!NEW").
        * 'UNANSWERED' - Messages that do not have the \Answered flag set.
        * 'UNDELETED' - Messages that do not have the \Deleted flag set.
        * 'UNDRAFT' - Messages that do not have the \Draft flag set.
        * 'UNFLAGGED' - Messages that do not have the \Flagged flag set.
        * 'UNSEEN' - Messages that do not have the \Seen flag set.
    * The following are valid criterion that require String value(s):
        * 'BCC' - Messages that contain the specified string in the BCC field.
        * 'CC' - Messages that contain the specified string in the CC field.
        * 'FROM' - Messages that contain the specified string in the FROM field.
        * 'SUBJECT' - Messages that contain the specified string in the SUBJECT field.
        * 'TO' - Messages that contain the specified string in the TO field.
        * 'BODY' - Messages that contain the specified string in the message body.
        * 'TEXT' - Messages that contain the specified string in the header OR the message body.
        * 'HEADER' - **Requires two String values with the first being the header name and the second being the value to search for.** If this second string is empty, all messages with the given header name will be returned. Example: [ ['UNSEEN'], ['HEADER', 'SUBJECT', 'node-imap'] ]
    * The following are valid criterion that require a String parseable by JavaScript's Date object, or an instance of Date:
        * 'BEFORE' - Messages whose internal date (disregarding time and timezone) is earlier than the specified date.
        * 'ON' - Messages whose internal date (disregarding time and timezone) is within the specified date.
        * 'SINCE' - Messages whose internal date (disregarding time and timezone) is within or later than the specified date.
        * 'SENTBEFORE' - Messages whose Date header (disregarding time and timezone) is earlier than the specified date.
        * 'SENTON' - Messages whose Date header (disregarding time and timezone) is within the specified date.
        * 'SENTSINCE' - Messages whose Date header (disregarding time and timezone) is within or later than the specified date.
    * The following are valid criterion that require an Integer value:
        * 'LARGER' - Messages with a size larger than the specified number of bytes.
        * 'SMALLER' - Messages with a size smaller than the specified number of bytes.
    * **Note:** By default, all criterion are ANDed together. You can use the special 'OR' on **two** criterion to find messages matching either search criteria (see example above).

* **fetch**(Integer, Object, Function) - _(void)_ - Fetches the message with the message ID specified by the Integer parameter in the currently open mailbox. The Function parameter is the callback with three parameters: the error (null if none), the _Box_ object of the currently open mailbox, and the _FetchResult_ containing the result of the fetch request. The Object parameter is a set of options used to determine how and what exactly to fetch. The valid options are:
    * **markSeen** - A Boolean indicating whether to mark the message as read when fetching it. **Default:** false
    * **request** - An Object indicating what to fetch (at least **headers** OR **body** must be set to false -- in other words, you can only fetch one aspect of the message at a time):
        * **struct** - A Boolean indicating whether to fetch the structure of the message. **Default:** true
        * **headers** - A Boolean/Array value. A value of true fetches all message headers. An Array containing specific message headers to retrieve can also be specified. **Default:** true
        * **body** - A Boolean/String/Array value. A Boolean value of true fetches the entire raw message body. A String value containing a valid partID (see _FetchResult_'s structure property) fetches the entire body/content of that particular part. An Array value of length 2 can be specified if you wish to request a byte range of the content, where the first item is a Boolean/String as previously described and the second item is a String indicating the byte range, for example, to fetch the first 500 bytes: '0-500'. **Default:** false

* **removeDeleted**(Function) - _(void)_ - Permanently removes all messages flagged as \Deleted. The Function parameter is the callback with two parameters: the error (null if none), the _Box_ object of the currently open mailbox.

* **addFlags**(Integer, String/Array, Function) - _(void)_ - Adds the specified flag(s) to the message identified by the Integer parameter. The second parameter can either be a String containing a single flag or can be an Array of flags. The Function parameter is the callback with two parameters: the error (null if none), the _Box_ object of the currently open mailbox.

* **delFlags**(Integer, String/Array, Function) - _(void)_ - Removes the specified flag(s) from the message identified by the Integer parameter. The second parameter can either be a String containing a single flag or can be an Array of flags. The Function parameter is the callback with two parameters: the error (null if none), the _Box_ object of the currently open mailbox.


TODO
----

A bunch of things not yet implemented in no particular order:

* Support AUTH=CRAM-MD5/AUTH=CRAM_MD5 authentication
* Support IMAP keywords (with a workaround for gmail's lack of support for IMAP keywords)
* Support additional IMAP commands/extensions:
  * GETQUOTA (via QUOTA extension -- http://tools.ietf.org/html/rfc2087)
  * UNSELECT (via UNSELECT extension -- http://tools.ietf.org/html/rfc3691)
  * LIST (and XLIST via XLIST extension -- http://groups.google.com/group/Gmail-Help-POP-and-IMAP-en/browse_thread/thread/a154105c54f020fb)
  * SORT (via SORT extension -- http://tools.ietf.org/html/rfc5256)
  * THREAD (via THREAD=ORDEREDSUBJECT and/or THREAD=REFERENCES extension(s) -- http://tools.ietf.org/html/rfc5256)
  * ID (via ID extension -- http://tools.ietf.org/html/rfc2971) ?