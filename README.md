Description
===========

node-imap is an IMAP module for [node.js](http://nodejs.org/) that provides an asynchronous interface for communicating with an IMAP mail server.

This module does not perform any magic such as auto-decoding of messages/attachments or parsing of email addresses (node-imap leaves all mail header values as-is).
If you are in need of this kind of extra functionality, check out andris9's [mimelib](https://github.com/andris9/mimelib) module. Also check out his [mailparser](http://github.com/andris9/mailparser) module, which comes in handy after you fetch() a 'full' raw email message with this module.


Requirements
============

* [node.js](http://nodejs.org/) -- v0.4.0 or newer
* An IMAP server -- tested with gmail


Installation
============

    npm install imap

Example
=======

* This example fetches the 'date', 'from', 'to', 'subject' message headers and the message structure of all unread messages in the Inbox since May 20, 2010:

```javascript
  var util = require('util'),
      ImapConnection = require('imap').ImapConnection;
      
  var imap = new ImapConnection({
        username: 'mygmailname@gmail.com',
        password: 'mygmailpassword',
        host: 'imap.gmail.com',
        port: 993,
        secure: true
      });

  function show(obj) {
    return util.inspect(obj, false, Infinity);
  }

  function die(err) {
    console.log('Uh oh: ' + err);
    process.exit(1);
  }

  function openInbox(cb) {
    imap.connect(function(err) {
      if (err) die(err);
      imap.openBox('INBOX', false, cb);
    });
  }

  openInbox(function(err, mailbox) {
    if (err) die(err);
    imap.search([ 'UNSEEN', ['SINCE', 'May 20, 2010'] ], function(err, results) {
      if (err) die(err);
      var fetch = imap.fetch(results, {
        request: {
          headers: ['from', 'to', 'subject', 'date']
        }
      });
      fetch.on('message', function(msg) {
        console.log('Got a message with sequence number ' + msg.seqno);
        msg.on('end', function() {
          // msg.headers is now an object containing the requested headers ...
          console.log('Finished message. Headers ' + show(msg.headers));
        });
      });
      fetch.on('end', function() {
        console.log('Done fetching all messages!');
        imap.logout(cb);
      });
    });
  });
```

* Here is a modified version of the first example that retrieves all (parsed) headers and writes the entire body of each message to a file:

```javascript
  // using the functions and variables already defined in the first example ...

  var fs = require('fs'), fileStream;

  openInbox(function(err, mailbox) {
    if (err) die(err);
    imap.search([ 'UNSEEN', ['SINCE', 'May 20, 2010'] ], function(err, results) {
      if (err) die(err);
      var fetch = imap.fetch(results, {
        request: {
          headers: true,
          body: true
        }
      });
      fetch.on('message', function(msg) {
        console.log('Got a message with sequence number ' + msg.seqno);
        fileStream = fs.createWriteStream('msg-' + msg.seqno + '-body.txt');
        msg.on('data', function(chunk) {
          fileStream.write(chunk);
        });
        msg.on('end', function() {
          fileStream.end();
          // msg.headers is now an object containing the requested headers ...
          console.log('Finished message. Headers: ' + show(msg.headers));
        });
      });
      fetch.on('end', function() {
        console.log('Done fetching all messages!');
        imap.logout(cb);
      });
    });
  });
```

* Here is a modified version of the first example that retrieves and writes entire raw messages to files (no parsed headers):

```javascript
  // using the functions and variables already defined in the first example ...

  var fs = require('fs'), fileStream;

  openInbox(function(err, mailbox) {
    if (err) die(err);
    imap.search([ 'UNSEEN', ['SINCE', 'May 20, 2010'] ], function(err, results) {
      if (err) die(err);
      var fetch = imap.fetch(results, {
        request: {
          headers: false,
          body: 'full'
        }
      });
      fetch.on('message', function(msg) {
        console.log('Got a message with sequence number ' + msg.seqno);
        fileStream = fs.createWriteStream('msg-' + msg.seqno + '-raw.txt');
        msg.on('data', function(chunk) {
          fileStream.write(chunk);
        });
        msg.on('end', function() {
          fileStream.end();
        });
      });
      fetch.on('end', function() {
        console.log('Done fetching all messages!');
        imap.logout(cb);
      });
    });
  });
```


API
===

node-imap exposes one object: **ImapConnection**.


#### Data types

* _Box_ is an object representing the currently open mailbox, and has the following properties:
    * **name** - A string containing the name of this mailbox.
    * **validity** - A string containing a number that indicates whether the message IDs in this mailbox have changed or not. In other words, as long as this value does not change on future openings of this mailbox, any cached message IDs for this mailbox are still valid.
    * **permFlags** - An array containing the flags that can be permanently added/removed to/from messages in this mailbox.
    * **messages** - An object containing properties about message counts for this mailbox.
        * **total** - An Integer representing total number of messages in this mailbox.
        * **new** - An Integer representing the number of new (unread) messages in this mailbox.
* _ImapMessage_ is an object representing an email message. It consists of:
    * Properties:
        * **id** - An Integer that uniquely identifies this message (within its mailbox).
        * **seqno** - An Integer that designates this message's sequence number. This number changes when messages with smaller sequence numbers are deleted for example (see the ImapConnection's 'deleted' event).
        * **flags** - An array containing the flags currently set on this message.
        * **date** - A string containing the internal server date for the message (always represented in GMT?)
        * **headers** - An object containing the headers of the message, **if headers were requested when calling fetch().** Note: Duplicate headers are dealt with by storing the duplicated values in an array keyed on the header name (e.g. { to: ['foo@bar.com', 'bar@baz.com'] }).
        * **structure** - An array containing the structure of the message, **if the structure was requested when calling fetch().** See below for an explanation of the format of this property.
    * Events:
        * **data**(<_Buffer_>chunk) - Emitted for each message body chunk if a message body is being fetched
        * **end**() - Emitted when the fetch is complete for this message and its properties
* _ImapFetch_ is an object that emits these events:
    * **message**(<_ImapMessage_>msg) - Emitted for each message resulting from a fetch request
    * **end**() - Emitted when the fetch request is complete

A message structure with multiple parts might look something like the following:

```javascript
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
      }
    , [ { partID: '1.1'
        , type: 'text'
        , subtype: 'plain'
        , params: { charset: 'ISO-8859-1' }
        , id: null
        , description: null
        , encoding: '7BIT'
        , size: 935
        , lines: 46
        , md5: null
        , disposition: null
        , language: null
        }
      ]
    , [ { partID: '1.2'
        , type: 'text'
        , subtype: 'html'
        , params: { charset: 'ISO-8859-1' }
        , id: null
        , description: null
        , encoding: 'QUOTED-PRINTABLE'
        , size: 1962
        , lines: 33
        , md5: null
        , disposition: null
        , language: null
        }
      ]
    ]
  , [ { partID: '2'
      , type: 'application'
      , subtype: 'octet-stream'
      , params: { name: 'somefile' }
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
```

The above structure describes a message having both an attachment and two forms of the message body (plain text and HTML).
Each message part is identified by a partID which is used when you want to fetch the content of that part (**see fetch()**).

The structure of a message with only one part will simply look something like this:

```javascript
  [ { partID: '1'
      , type: 'text'
      , subtype: 'plain'
      , params: { charset: 'ISO-8859-1' }
      , id: null
      , description: null
      , encoding: '7BIT'
      , size: 935
      , lines: 46
      , md5: null
      , disposition: null
      , language: null
    }
  ]
```

Therefore, an easy way to check for a multipart message is to check if the structure length is >1.

Lastly, here are the system flags defined by the IMAP spec (that may be added/removed to/from messages):

* Seen - Message has been read
* Answered - Message has been answered
* Flagged - Message is "flagged" for urgent/special attention
* Deleted - Message is "deleted" for removal
* Draft - Message has not completed composition (marked as a draft).

It should be noted however that the IMAP server can limit which flags can be permanently modified for any given message. If in doubt, check the mailbox's **permFlags** array first.
Additional custom flags may be provided by the server. If available, these will also be listed in the mailbox's **permFlags** array.


ImapConnection Events
---------------------

* **alert**(<_string_>alertMsg) - Fires when the server issues an alert (e.g. "the server is going down for maintenance").

* **mail**(<_integer_>numNewMsgs) - Fires when new mail arrives in the currently open mailbox.

* **deleted**(<_integer_>seqno) - Fires when a message is deleted from another IMAP connection's session. The callback's argument is the *sequence number* (instead of the unique ID) of the message that was deleted. The sequence numbers of all messages higher than this value **MUST** be decremented by 1 in order to stay synchronized with the server and to keep the continuity of the sequence numbers.

* **msgupdate**(<_ImapMessage_>msg) - Fires when a message's flags have changed, generally from another IMAP connection's session. With that in mind, the only available properties in this case will almost always only be 'seqno' and 'flags' (no 'data' or 'end' events will be emitted on the object).

* **close**(<_boolean_>hadError) - Fires when the connection is completely closed.

* **end**() - Fires when the connection is ended.

* **error**(<_Error_>err) - Fires when an exception/error occurs.


ImapConnection Properties
-------------------------

* **capabilities** - <_array_> - Contains the IMAP capabilities of the server.

* **delim** - <_string_> - The (top-level) mailbox hierarchy delimiter. If the server does not support mailbox hierarchies and only a flat list, this value will be `false`.

* **namespaces** - <_object_> - Contains information about each namespace type (if supported by the server) with the following properties:

   * **personal** - <_array_> - Mailboxes that belong to the logged in user

   * **other** - <_array_> - Mailboxes that belong to other users that the logged in user has access to

   * **shared** - <_array_> - Mailboxes that are accessible by any logged in user
   
   There should always be at least one entry (although the IMAP spec allows for more, it doesn't seem to be very common) in the personal namespace list, with a blank namespace prefix. Each property's array contains objects of the following format (with example values):

```javascript
  { prefix: '' // A string containing the prefix to use to access mailboxes in this namespace
  , delim: '/' // A string containing the hierarchy delimiter for this namespace, or boolean false
              //  for a flat namespace with no hierarchy
  , extensions: [ // An array of namespace extensions supported by this namespace, or null if none
                  // are specified
        { name: 'X-FOO-BAR' // A string indicating the extension name
        , params: [ 'BAZ' ] // An array of strings containing the parameters for this extension,
                            // or null if none are specified
        }
    ]
  }
```


ImapConnection Functions
------------------------

**Note:** Message ID sets for message ID range arguments are not guaranteed to be contiguous.

* **(constructor)**([<_object_>config]) - _ImapConnection_ - Creates and returns a new instance of ImapConnection using the specified configuration object. Valid config properties are:

    * **username** - <_string_> - Username for plain-text authentication.

    * **password** - <_string_> - Password for plain-text authentication.

    * **xoauth** - <_string_> - OAuth token for [OAuth authentication](https://sites.google.com/site/oauthgoog/Home/oauthimap) for servers that support it.

    * **host** - <_string_> - Hostname or IP address of the IMAP server. **Default:** "localhost"

    * **port** - <_integer_> - Port number of the IMAP server. **Default:** 143

    * **secure** - <_boolean_> - Use SSL/TLS? **Default:** false

    * **connTimeout** - <_integer_> - Number of milliseconds to wait for a connection to be established. **Default:** 10000

* **connect**(<_function_>callback) - _(void)_ - Attempts to connect and log into the IMAP server. The callback has one parameter: the error (falsey if none).

* **logout**(<_function_>callback) - _(void)_ - Closes the connection to the server.

* **openBox**(<_string_>mailboxName[, <_boolean_>openReadOnly=false], <_function_>callback) - _(void)_ - Opens a specific mailbox that exists on the server. mailboxName should include any necessary prefix/path. The callback has two parameters: the error (falsey if none), and the _Box_ object containing information about the newly opened mailbox.

* **closeBox**(<_function_>callback) - _(void)_ - Closes the currently open mailbox. **Any messages marked as Deleted in the mailbox will be removed if the mailbox was NOT opened in read-only mode.** Additionally, logging out or opening another mailbox without closing the current one first will NOT cause deleted messages to be removed. The callback has one parameter: the error (falsey if none).

* **addBox**(<_string_>mailboxName, <_function_>callback) - _(void)_ - Creates a new mailbox on the server. mailboxName should include any necessary prefix/path. The callback has one parameter: the error (falsey if none).

* **delBox**(<_string_>mailboxName, <_function_>callback) - _(void)_ - Removes a specific mailbox that exists on the server. mailboxName should including any necessary prefix/path. The callback has one parameter: the error (falsey if none).

* **renameBox**(<_string_>oldMailboxName, <_string_>newMailboxName, <_function_>callback) - _(void)_ - Renames a specific mailbox that exists on the server. Both oldMailboxName and newMailboxName should include any necessary prefix/path. The callback has two parameters: the error (falsey if none), and the _Box_ object containing information about the newly renamed mailbox. **Note:** Renaming the 'INBOX' mailbox will instead cause all messages in 'INBOX' to be moved to the new mailbox.

* **status**(<_string_>mailboxName, <_function_>callback) - _(void)_ - Fetches information about a mailbox other than the one currently open. The callback has two parameters: the error (falsey if none), and the _Box_ object containing information about the specific mailbox. **Note:** There is no guarantee that this will be a fast operation on the server. Also, do *not* call this on the currently open mailbox.

* **getBoxes**([<_string_>nsPrefix,] <_function_>callback) - _(void)_ - Obtains the full list of mailboxes. If nsPrefix is not specified, the main personal namespace is used. The callback has two parameters: the error (falsey if none), and an object with the following format (with example values):

```javascript
  { INBOX: // mailbox name
     { attribs: [] // mailbox attributes. An attribute of 'NOSELECT' indicates the mailbox cannot
                   // be opened
     , delim: '/' // hierarchy delimiter for accessing this mailbox's direct children.
     , children: null // an object containing another structure similar in format to this top level,
                      // otherwise null if no children
     , parent: null // pointer to parent mailbox, null if at the top level
     }
  , Work:
     { attribs: []
     , delim: '/'
     , children: null
     , parent: null
     }
  , '[Gmail]':
     { attribs: [ 'NOSELECT' ]
     , delim: '/'
     , children:
        { 'All Mail':
           { attribs: []
           , delim: '/'
           , children: null
           , parent: [Circular]
           }
        , Drafts:
           { attribs: []
           , delim: '/'
           , children: null
           , parent: [Circular]
           }
        , 'Sent Mail':
           { attribs: []
           , delim: '/'
           , children: null
           , parent: [Circular]
           }
        , Spam:
           { attribs: []
           , delim: '/'
           , children: null
           , parent: [Circular]
           }
        , Starred:
           { attribs: []
           , delim: '/'
           , children: null
           , parent: [Circular]
           }
        , Trash:
           { attribs: []
           , delim: '/'
           , children: null
           , parent: [Circular]
           }
        }
     , parent: null
     }
  }
```

* **removeDeleted**(<_function_>callback) - _(void)_ - Permanently removes (EXPUNGEs) all messages flagged as Deleted in the mailbox that is currently open. The callback has one parameter: the error (falsey if none). **Note:** At least on Gmail, performing this operation with any currently open mailbox that is not the Spam or Trash mailbox will merely archive any messages marked as Deleted (by moving them to the 'All Mail' mailbox).

* **append**(<_mixed_>msgData, [<_object_>options,] <_function_>callback) - _(void)_ - Appends a message to selected mailbox. msgData is a string or Buffer containing an RFC-822 compatible MIME message. Valid options are:

    * **mailbox** - <_string_> - The name of the mailbox to append the message to. **Default:** the currently open mailbox

    * **flags** - <_mixed_> - A single flag (e.g. 'Seen') or an array of flags (e.g. `['Seen', 'Flagged']`) to append to the message. **Default:** (no flags)

    * **date** - <_date_> - What to use for message arrival date/time. **Default:** (current date/time)
    
  The callback has one parameter: the error (falsey if none).

**All functions below have sequence number-based counterparts that can be accessed by using the 'seq' namespace of the imap connection's instance (e.g. conn.seq.search() returns sequence number(s) instead of unique ids, conn.seq.fetch() fetches by sequence number(s) instead of unique ids, etc):**

* **search**(<_array_>criteria, <_function_>callback) - _(void)_ - Searches the currently open mailbox for messages using given criteria. criteria is a list describing what you want to find. For criteria types that require arguments, use an array instead of just the string criteria type name (e.g. ['FROM', 'foo@bar.com']). Prefix criteria types with an "!" to negate.

    * The following message flags are valid types that do not have arguments:

        * 'ALL' - All messages.

        * 'ANSWERED' - Messages with the Answered flag set.

        * 'DELETED' - Messages with the Deleted flag set.

        * 'DRAFT' - Messages with the Draft flag set.

        * 'FLAGGED' - Messages with the Flagged flag set.

        * 'NEW' - Messages that have the Recent flag set but not the Seen flag.

        * 'SEEN' - Messages that have the Seen flag set.

        * 'RECENT' - Messages that have the Recent flag set.

        * 'OLD' - Messages that do not have the Recent flag set. This is functionally equivalent to "!RECENT" (as opposed to "!NEW").

        * 'UNANSWERED' - Messages that do not have the Answered flag set.

        * 'UNDELETED' - Messages that do not have the Deleted flag set.

        * 'UNDRAFT' - Messages that do not have the Draft flag set.

        * 'UNFLAGGED' - Messages that do not have the Flagged flag set.

        * 'UNSEEN' - Messages that do not have the Seen flag set.

    * The following are valid types that require string value(s):

        * 'BCC' - Messages that contain the specified string in the BCC field.

        * 'CC' - Messages that contain the specified string in the CC field.

        * 'FROM' - Messages that contain the specified string in the FROM field.

        * 'SUBJECT' - Messages that contain the specified string in the SUBJECT field.

        * 'TO' - Messages that contain the specified string in the TO field.

        * 'BODY' - Messages that contain the specified string in the message body.

        * 'TEXT' - Messages that contain the specified string in the header OR the message body.

        * 'KEYWORD' - Messages with the specified keyword set.

        * 'HEADER' - **Requires two string values, with the first being the header name and the second being the value to search for.** If this second string is empty, all messages that contain the given header name will be returned.

    * The following are valid types that require a string parseable by JavaScript's Date object OR a Date instance:

        * 'BEFORE' - Messages whose internal date (disregarding time and timezone) is earlier than the specified date.

        * 'ON' - Messages whose internal date (disregarding time and timezone) is within the specified date.

        * 'SINCE' - Messages whose internal date (disregarding time and timezone) is within or later than the specified date.

        * 'SENTBEFORE' - Messages whose Date header (disregarding time and timezone) is earlier than the specified date.

        * 'SENTON' - Messages whose Date header (disregarding time and timezone) is within the specified date.

        * 'SENTSINCE' - Messages whose Date header (disregarding time and timezone) is within or later than the specified date.

    * The following are valid types that require one Integer value:

        * 'LARGER' - Messages with a size larger than the specified number of bytes.

        * 'SMALLER' - Messages with a size smaller than the specified number of bytes.

    * The following are valid criterion that require one or more Integer values:

        * 'UID' - Messages with message IDs corresponding to the specified message ID set. Ranges are permitted (e.g. '2504:2507' or '\*' or '2504:\*').

    * **Note #1:** For the ID-based search (i.e. "conn.search()"), you can retrieve the IDs for sequence numbers by just supplying an array of sequence numbers and/or ranges as a criteria (e.g. [ '24:29', 19, '66:*' ]).

    * **Note #2:** By default, all criterion are ANDed together. You can use the special 'OR' on **two** criterion to find messages matching either search criteria (see example below).

  criteria examples:

    * Unread messages since April 20, 2010: [ 'UNSEEN', ['SINCE', 'April 20, 2010'] ]

    * Messages that are EITHER unread OR are dated April 20, 2010 or later, you could use: [ ['OR', 'UNSEEN', ['SINCE', 'April 20, 2010'] ] ]

    * All messages that have 'node-imap' in the subject header: [ ['HEADER', 'SUBJECT', 'node-imap'] ]

    * All messages that _do not_ have 'node-imap' in the subject header: [ ['!HEADER', 'SUBJECT', 'node-imap'] ]
    
  The callback has two parameters: the error (falsey if none), and an array containing the message IDs matching the search criteria.

* **fetch**(<_mixed_>source, <_object_>options) - _ImapFetch_ - Fetches message(s) in the currently open mailbox. source can be a message ID, a message ID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an array of message IDs and/or message ID ranges. Valid options are:

    * **markSeen** - <_boolean_> - Mark message(s) as read when fetched. **Default:** false

    * **request** - <_object_> - What to fetch. Valid options are:

        * **struct** - <_boolean_> - Fetch the message structure. **Default:** true

        * **headers** - <_mixed_> - Boolean true fetches all message headers and an array of header names retrieves only those headers. **Default:** true

        * **body** - <_mixed_> - Boolean true fetches the entire raw message body. A string containing a valid partID (see _FetchResult_'s structure property) fetches the entire body of that particular part. The string 'full' fetches the entire (unparsed) email message, including the headers. An array can be given to specify a byte range of the content, where the first value is boolean true or a partID and the second value is the byte range. For example, to fetch the first 500 bytes: '0-500'. **Default:** false

* **copy**(<_mixed_>source, <_string_>mailboxName, <_function_>callback) - _(void)_ - Copies message(s) in the currently open mailbox to another mailbox. source can be a message ID, a message ID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an array of message IDs and/or message ID ranges. The callback has one parameter: the error (falsey if none).

* **move**(<_mixed_>source, <_string_>mailboxName, <_function_>callback) - _(void)_ - Moves message(s) in the currently open mailbox to another mailbox. source can be a message ID, a message ID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an array of message IDs and/or message ID ranges. The callback has one parameter: the error (falsey if none). **Note:** The message(s) in the destination mailbox will have a new message ID.

* **addFlags**(<_mixed_>source, <_mixed_>flags, <_function_>callback) - _(void)_ - Adds flag(s) to message(s). source can be a message ID, a message ID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an array of message IDs and/or message ID ranges. flags is either a single flag or an array of flags. The callback has one parameter: the error (falsey if none).

* **delFlags**(<_mixed_>source, <_mixed_>flags, <_function_>callback) - _(void)_ - Removes flag(s) from message(s). source can be a message ID, a message ID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an array of message IDs and/or message ID ranges. flags is either a single flag or an array of flags. The callback has one parameter: the error (falsey if none).

* **addKeywords**(<_mixed_>source, <_mixed_>keywords, <_function_>callback) - _(void)_ - Adds keyword(s) to message(s). source can be a message ID, a message ID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an array of message IDs and/or message ID ranges. keywords is either a single keyword or an array of keywords. The callback has one parameter: the error (falsey if none).

* **delKeywords**(<_mixed_>source, <_mixed_>keywords, <_function_>callback) - _(void)_ - Removes keyword(s) from message(s). source can be a message ID, a message ID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an array of message IDs and/or message ID ranges. keywords is either a single keyword or an array of keywords. The callback has one parameter: the error (falsey if none).


Extensions Supported
--------------------

* **Gmail**

    * Server capability: X-GM-EXT-1

    * search() criteria extensions

        * X-GM-RAW: string value which allows you to use Gmail's web interface search syntax, such as: "has:attachment in:unread"

        * X-GM-THRID: allows you to search for a specific conversation/thread id which is associated with groups of messages

        * X-GM-MSGID: allows you to search for a specific message given its account-wide unique id

        * X-GM-LABELS: string value which allows you to search for specific messages that have the given label applied

    * fetch() will automatically retrieve the thread id, unique message id, and labels with the message properties being 'x-gm-thrid', 'x-gm-msgid', 'x-gm-labels' respectively


TODO
----

Several things not yet implemented in no particular order:

* Support STARTTLS
* Support AUTH=CRAM-MD5/AUTH=CRAM_MD5 authentication
* Multipart parsing capabilities
* Support additional IMAP commands/extensions:
  * NOTIFY (via NOTIFY extension -- http://tools.ietf.org/html/rfc5465)
  * STATUS addition to LIST (via LIST-STATUS extension -- http://tools.ietf.org/html/rfc5819)
  * GETQUOTA (via QUOTA extension -- http://tools.ietf.org/html/rfc2087)
  * UNSELECT (via UNSELECT extension -- http://tools.ietf.org/html/rfc3691)
  * SORT (via SORT extension -- http://tools.ietf.org/html/rfc5256)
  * THREAD (via THREAD=ORDEREDSUBJECT and/or THREAD=REFERENCES extension(s) -- http://tools.ietf.org/html/rfc5256)
  * ID (via ID extension -- http://tools.ietf.org/html/rfc2971) ?