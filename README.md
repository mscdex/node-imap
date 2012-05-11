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

This example fetches the 'date', 'from', 'to', 'subject' message headers and the message structure of all unread messages in the Inbox since May 20, 2010:

    var ImapConnection = require('./imap').ImapConnection, util = require('util'),
        imap = new ImapConnection({
          username: 'mygmailname@gmail.com',
          password: 'mygmailpassword',
          host: 'imap.gmail.com',
          port: 993,
          secure: true
        });

    function die(err) {
      console.log('Uh oh: ' + err);
      process.exit(1);
    }

    var box, cmds, next = 0, cb = function(err) {
      if (err)
        die(err);
      else if (next < cmds.length)
        cmds[next++].apply(this, Array.prototype.slice.call(arguments).slice(1));
    };
    cmds = [
      function() { imap.connect(cb); },
      function() { imap.openBox('INBOX', false, cb); },
      function(result) { box = result; imap.search([ 'UNSEEN', ['SINCE', 'May 20, 2010'] ], cb); },
      function(results) {
        var fetch = imap.fetch(results, { request: { headers: ['from', 'to', 'subject', 'date'] } });
        fetch.on('message', function(msg) {
          console.log('Got message: ' + util.inspect(msg, false, 5));
          msg.on('data', function(chunk) {
            console.log('Got message chunk of size ' + chunk.length);
          });
          msg.on('end', function() {
            console.log('Finished message: ' + util.inspect(msg, false, 5));
          });
        });
        fetch.on('end', function() {
          console.log('Done fetching all messages!');
          imap.logout(cb);
        });
      }
    ];
    cb();


API
===

node-imap exposes one object: **ImapConnection**.


#### Data types

* _Box_ is an Object representing the currently open mailbox, and has the following properties:
    * **name** - A String containing the name of this mailbox.
    * **validity** - A String containing a number that indicates whether the message IDs in this mailbox have changed or not. In other words, as long as this value does not change on future openings of this mailbox, any cached message IDs for this mailbox are still valid.
    * **permFlags** - An Array containing the flags that can be permanently added/removed to/from messages in this mailbox.
    * **messages** - An Object containing properties about message counts for this mailbox.
        * **total** - An Integer representing total number of messages in this mailbox.
        * **new** - An Integer representing the number of new (unread) messages in this mailbox.
* _ImapMessage_ is an Object representing an email message. It consists of:
    * Properties:
        * **id** - An Integer that uniquely identifies this message (within its mailbox).
        * **seqno** - An Integer that designates this message's sequence number. This number changes when messages with smaller sequence numbers are deleted for example (see the ImapConnection's 'deleted' event).
        * **flags** - An Array containing the flags currently set on this message.
        * **date** - A String containing the internal server date for the message (always represented in GMT?)
        * **headers** - An Object containing the headers of the message, **if headers were requested when calling fetch().** Note: The value of each property in the object is an Array containing the value(s) for that particular header name (just in case there are duplicate headers).
        * **structure** - An Array containing the structure of the message, **if the structure was requested when calling fetch().** See below for an explanation of the format of this property.
    * Events:
        * **data**(String) - Emitted for each message body chunk if a message body is being fetched
        * **end** - Emitted when the fetch is complete for this message and its properties
* _ImapFetch_ is an Object that emits these events:
    * **message**(ImapMessage) - Emitted for each message resulting from a fetch request
    * **end** - Emitted when the fetch request is complete

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
The above structure describes a message having both an attachment and two forms of the message body (plain text and HTML).
Each message part is identified by a partID which is used when you want to fetch the content of that part (**see fetch()**).

The structure of a message with only one part will simply look something like this:

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
Therefore, an easy way to check for a multipart message is to check if the structure length is >1.

Lastly, here are the system flags defined by the IMAP spec (that may be added/removed to/from messages):

* Seen - Message has been read
* Answered - Message has been answered
* Flagged - Message is "flagged" for urgent/special attention
* Deleted - Message is "deleted" for removal
* Draft - Message has not completed composition (marked as a draft).

It should be noted however that the IMAP server can limit which flags can be permanently modified for any given message. If in doubt, check the mailbox's **permFlags** Array first.
Additional custom flags may be provided by the server. If available, these will also be listed in the mailbox's **permFlags** Array.


ImapConnection Events
---------------------

* **alert**(String) - Fires when the server issues an alert (e.g. "the server is going down for maintenance"). The supplied String is the text of the alert message.

* **mail**(Integer) - Fires when new mail arrives in the currently open mailbox. The supplied Integer specifies the number of new messages.

* **deleted**(Integer) - Fires when a message is deleted from another IMAP connection's session. The Integer value is the *sequence number* (instead of the unique ID) of the message that was deleted. The sequence numbers of all messages higher than this value **MUST** be decremented by 1 in order to stay synchronized with the server and to keep continuity of sequence numbers.

* **msgupdate**(ImapMessage) - Fires when a message's flags have changed, generally from another IMAP connection's session. With that in mind, the only available properties in this case will almost always be 'seqno' and 'flags' (and obviously no 'data' or 'end' events will be emitted on the object).

* **close**(Boolean) - Fires when the connection is completely closed (similar to net.Stream's close event). The specified Boolean indicates whether the connection was terminated due to a transmission error or not.

* **end**() - Fires when the connection is ended (similar to net.Stream's end event).

* **error**(Error) - Fires when an exception/error occurs (similar to net.Stream's error event). The given Error object represents the error raised.


ImapConnection Properties
-------------------------

* **capabilities** - An Array containing the capabilities of the server.

* **delim** - A String containing the (top-level) mailbox hierarchy delimiter. If the server does not support mailbox hierarchies and only a flat list, this value will be Boolean false.

* **namespaces** - An Object containing 3 properties, one for each namespace type: personal (mailboxes that belong to the logged in user), other (mailboxes that belong to other users that the logged in user has access to), and shared (mailboxes that are accessible by any logged in user). The value of each of these properties is an Array of namespace Objects containing necessary information about each available namespace. There should always be one entry (although the IMAP spec allows for more, it doesn't seem to be very common) in the personal namespace list (if the server supports namespaces) with a blank namespace prefix. Each namespace Object has the following format (with example values):

        { prefix: '' // A String containing the prefix to use to access mailboxes in this namespace
        , delim: '/' // A String containing the hierarchy delimiter for this namespace, or Boolean false for a flat namespace with no hierarchy
        , extensions: [ // An Array of namespace extensions supported by this namespace, or null if none are specified
              { name: 'X-FOO-BAR' // A String indicating the extension name
              , params: [ 'BAZ' ] // An Array of Strings containing the parameters for this extension, or null if none are specified
              }
          ]
        }


ImapConnection Functions
------------------------

**Note:** Message ID sets for message ID range arguments are not guaranteed to be contiguous.

* **(constructor)**([Object]) - _ImapConnection_ - Creates and returns a new instance of ImapConnection using the specified configuration object. Valid properties of the passed in object are:
    * **username** - A String representing the username for plain-text authentication.
    * **password** - A String representing the password for plain-text authentication.
    * **xoauth** - A String containing an OAuth token for [OAuth authentication](https://sites.google.com/site/oauthgoog/Home/oauthimap) for servers that support it.
    * **host** - A String representing the hostname or IP address of the IMAP server. **Default:** "localhost"
    * **port** - An Integer representing the port of the IMAP server. **Default:** 143
    * **secure** - A Boolean indicating the connection should use SSL/TLS. **Default:** false
    * **connTimeout** - An Integer indicating the number of milliseconds to wait for a connection to be established. **Default:** 10000

* **connect**(Function) - _(void)_ - Attempts to connect and log into the IMAP server. The Function parameter is the callback with one parameter: the error (null if none).

* **logout**(Function) - _(void)_ - Closes the connection to the server. The Function parameter is the callback.

* **openBox**(String[, Boolean], Function) - _(void)_ - Opens a specific mailbox that exists on the server. The String parameter is the name (including any necessary prefix/path) of the mailbox to open. The optional Boolean parameter specifies if the mailbox should be opened in read-only mode (defaults to false). The Function parameter is the callback with two parameters: the error (null if none), and the _Box_ object of the newly opened mailbox.

* **closeBox**(Function) - _(void)_ - Closes the currently open mailbox. **Any messages marked as Deleted in the mailbox will be removed if the mailbox was NOT opened in read-only mode.** Also, logging out or opening another mailbox without closing the current one first will NOT cause deleted messages to be removed. The Function parameter is the callback with one parameter: the error (null if none).

* **addBox**(String, Function) - _(void)_ - Creates a new mailbox on the server. The String parameter is the name (including any necessary prefix/path) of the new mailbox to create. The Function parameter is the callback with one parameter: the error (null if none).

* **delBox**(String, Function) - _(void)_ - Removes a specific mailbox that exists on the server. The String parameter is the name (including any necessary prefix/path) of the mailbox to remove. The Function parameter is the callback with one parameter: the error (null if none).

* **renameBox**(String, String, Function) - _(void)_ - Renames a specific mailbox that exists on the server. The first String parameter is the name (including any necessary prefix/path) of the existing mailbox. The second String parameter is the name (including any necessary prefix/path) of the new mailbox. The Boolean parameter specifies whether to open the mailbox in read-only mode or not. The Function parameter is the callback with two parameters: the error (null if none), and the _Box_ object of the newly renamed mailbox. **Note:** Renaming the 'INBOX' mailbox will instead cause all messages in 'INBOX' to be moved to the new mailbox.

* **getBoxes**([String, ]Function) - _(void)_ - Obtains the full list of mailboxes. The optional String parameter is the namespace prefix to use (defaults to the main personal namespace). The Function parameter is the callback with two parameters: the error (null if none), and an Object with the following format (with example values):

        { INBOX: // mailbox name
           { attribs: [] // mailbox attributes. An attribute of 'NOSELECT' indicates the mailbox cannot be opened
           , delim: '/' // hierarchy delimiter for accessing this mailbox's direct children. This should usually be the same as ImapConnection.delim (?)
           , children: null // an Object containing another structure similar in format to this top level, null if no children
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

* **removeDeleted**(Function) - _(void)_ - Permanently removes (EXPUNGEs) all messages flagged as Deleted in the mailbox that is currently open. The Function parameter is the callback with one parameter: the error (null if none). **Note:** At least on Gmail, performing this operation with any currently open mailbox that is not the Spam or Trash mailbox will merely archive any messages marked as Deleted (by moving them to the 'All Mail' mailbox).

* **append**(Buffer/String, [Object,] Function) - _(void)_ - Appends a message to selected mailbox. The first parameter is a string or Buffer containing an RFC-822 compatible MIME message. The Function parameter is the callback with one parameter: the error (null if none). The second parameter is an options object. Valid options are:
    * **mailbox** - The name of the mailbox to append the message to. **Default:** the currently open mailbox
    * **flags** - Either a string (e.g. 'Seen') or an Array (e.g. `['Seen', 'Flagged']`) of flags to append to the message. **Default:** (no flags)
    * **date** - A Date object that denotes when the message was received. **Default:** (current date/time)

**All functions below have sequence number-based counterparts that can be accessed by using the 'seq' namespace of the imap connection's instance (e.g. conn.seq.search() returns sequence numbers instead of unique ids, conn.seq.fetch() fetches by sequence number(s) instead of unique ids, etc):**

* **search**(Array, Function) - _(void)_ - Searches the currently open mailbox for messages using specific criterion. The Function parameter is the callback with two parameters: the error (null if none) and an Array containing the message IDs matching the search criterion. The Array parameter is a list of Arrays containing the criterion (and any required arguments) to be used. Prefix the criteria name with an "!" to negate. For example, to search for unread messages since April 20, 2010 you could use: [ 'UNSEEN', ['SINCE', 'April 20, 2010'] ]. To search for messages that are EITHER unread OR are dated April 20, 2010 or later, you could use: [ ['OR', 'UNSEEN', ['SINCE', 'April 20, 2010'] ] ].
    * The following message flags are valid criterion and do not require values:
        * 'ALL' - All messages.
        * 'ANSWERED' - Messages with the Answered flag set.
        * 'DELETED' - Messages with the Deleted flag set.
        * 'DRAFT' - Messages with the Draft flag set.
        * 'FLAGGED' - Messages with the Flagged flag set.
        * 'NEW' - Messages that have the Recent flag set but not the Seen flag.
        * 'SEEN' - Messages that have the Seen flag set.
        * 'RECENT' - Messages that have the Recent flag set.
        * 'OLD' - Messages that do not have the Recent flag set. This is functionally equivalent to a criteria of "!RECENT" (as opposed to "!NEW").
        * 'UNANSWERED' - Messages that do not have the Answered flag set.
        * 'UNDELETED' - Messages that do not have the Deleted flag set.
        * 'UNDRAFT' - Messages that do not have the Draft flag set.
        * 'UNFLAGGED' - Messages that do not have the Flagged flag set.
        * 'UNSEEN' - Messages that do not have the Seen flag set.
    * The following are valid criterion that require String value(s):
        * 'BCC' - Messages that contain the specified string in the BCC field.
        * 'CC' - Messages that contain the specified string in the CC field.
        * 'FROM' - Messages that contain the specified string in the FROM field.
        * 'SUBJECT' - Messages that contain the specified string in the SUBJECT field.
        * 'TO' - Messages that contain the specified string in the TO field.
        * 'BODY' - Messages that contain the specified string in the message body.
        * 'TEXT' - Messages that contain the specified string in the header OR the message body.
        * 'KEYWORD' - Messages with the specified keyword set.
        * 'HEADER' - **Requires two String values with the first being the header name and the second being the value to search for.** If this second string is empty, all messages with the given header name will be returned. Example: [ ['UNSEEN'], ['HEADER', 'SUBJECT', 'node-imap'] ]
    * The following are valid criterion that require a String parseable by JavaScript's Date object, or an instance of Date:
        * 'BEFORE' - Messages whose internal date (disregarding time and timezone) is earlier than the specified date.
        * 'ON' - Messages whose internal date (disregarding time and timezone) is within the specified date.
        * 'SINCE' - Messages whose internal date (disregarding time and timezone) is within or later than the specified date.
        * 'SENTBEFORE' - Messages whose Date header (disregarding time and timezone) is earlier than the specified date.
        * 'SENTON' - Messages whose Date header (disregarding time and timezone) is within the specified date.
        * 'SENTSINCE' - Messages whose Date header (disregarding time and timezone) is within or later than the specified date.
    * The following are valid criterion that require one Integer value:
        * 'LARGER' - Messages with a size larger than the specified number of bytes.
        * 'SMALLER' - Messages with a size smaller than the specified number of bytes.
    * The following are valid criterion that require one or more Integer values:
        * 'UID' - Messages with message IDs corresponding to the specified message ID set. Ranges are permitted (e.g. '2504:2507' or '\*' or '2504:\*').
    * **Note:** By default, all criterion are ANDed together. You can use the special 'OR' on **two** criterion to find messages matching either search criteria (see example above).

* **fetch**(Integer/String/Array, Object) - _ImapFetch_ - Fetches the message(s) identified by the first parameter, in the currently open mailbox. The first parameter can either be an Integer for a single message ID, a String for a message ID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an Array containing any number of the aforementioned Integers and/or Strings. The second (Object) parameter is a set of options used to determine how and what exactly to fetch. The valid options are:
    * **markSeen** - A Boolean indicating whether to mark the message(s) as read when fetching it. **Default:** false
    * **request** - An Object indicating what to fetch (at least **headers** OR **body** must be set to false -- in other words, you can only fetch one aspect of the message at a time):
        * **struct** - A Boolean indicating whether to fetch the structure of the message. **Default:** true
        * **headers** - A Boolean/Array value. A value of true fetches all message headers. An Array containing specific message headers to retrieve can also be specified. **Default:** true
        * **body** - A Boolean/String/Array value. A Boolean value of true fetches the entire raw message body. A String value containing a valid partID (see _FetchResult_'s structure property) fetches the entire body/content of that particular part, or a String value of 'full' fetches the entire email message, including the headers. An Array value of length 2 can be specified if you wish to request a byte range of the content, where the first item is a Boolean/String as previously described and the second item is a String indicating the byte range, for example, to fetch the first 500 bytes: '0-500'. **Default:** false

* **copy**(Integer/String/Array, String, Function) - _(void)_ - Copies the message(s) with the message ID(s) identified by the first parameter, in the currently open mailbox, to the mailbox specified by the second parameter. The first parameter can either be an Integer for a single message ID, a String for a message ID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an Array containing any number of the aforementioned Integers and/or Strings. The Function parameter is the callback with one parameter: the error (null if none).

* **move**(Integer/String/Array, String, Function) - _(void)_ - Moves the message(s) with the message ID(s) identified by the first parameter, in the currently open mailbox, to the mailbox specified by the second parameter. The first parameter can either be an Integer for a single message ID, a String for a message ID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an Array containing any number of the aforementioned Integers and/or Strings. The Function parameter is the callback with one parameter: the error (null if none). **Note:** The message in the destination mailbox will have a new message ID.

* **addFlags**(Integer/String/Array, String/Array, Function) - _(void)_ - Adds the specified flag(s) to the message(s) identified by the first parameter. The first parameter can either be an Integer for a single message ID, a String for a message ID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an Array containing any number of the aforementioned Integers and/or Strings. The second parameter can either be a String containing a single flag or can be an Array of flags. The Function parameter is the callback with one parameter: the error (null if none).

* **delFlags**(Integer/String/Array, String/Array, Function) - _(void)_ - Removes the specified flag(s) from the message(s) identified by the first parameter. The first parameter can either be an Integer for a single message ID, a String for a message ID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an Array containing any number of the aforementioned Integers and/or Strings. The second parameter can either be a String containing a single flag or can be an Array of flags. The Function parameter is the callback with one parameter: the error (null if none).

* **addKeywords**(Integer/String/Array, String/Array, Function) - _(void)_ - Adds the specified keyword(s) to the message(s) identified by the first parameter. The first parameter can either be an Integer for a single message ID, a String for a message ID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an Array containing any number of the aforementioned Integers and/or Strings. The second parameter can either be a String containing a single keyword or can be an Array of keywords. The Function parameter is the callback with one parameter: the error (null if none).

* **delKeywords**(Integer/String/Array, String/Array, Function) - _(void)_ - Removes the specified keyword(s) from the message(s) identified by the first parameter. The first parameter can either be an Integer for a single message ID, a String for a message ID range (e.g. '2504:2507' or '\*' or '2504:\*'), or an Array containing any number of the aforementioned Integers and/or Strings. The second parameter can either be a String containing a single keyword or can be an Array of keywords. The Function parameter is the callback with one parameter: the error (null if none).


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
* Support additional IMAP commands/extensions:
  * NOTIFY (via NOTIFY extension -- http://tools.ietf.org/html/rfc5465)
  * STATUS addition to LIST (via LIST-STATUS extension -- http://tools.ietf.org/html/rfc5819)
  * GETQUOTA (via QUOTA extension -- http://tools.ietf.org/html/rfc2087)
  * UNSELECT (via UNSELECT extension -- http://tools.ietf.org/html/rfc3691)
  * SORT (via SORT extension -- http://tools.ietf.org/html/rfc5256)
  * THREAD (via THREAD=ORDEREDSUBJECT and/or THREAD=REFERENCES extension(s) -- http://tools.ietf.org/html/rfc5256)
  * ID (via ID extension -- http://tools.ietf.org/html/rfc2971) ?