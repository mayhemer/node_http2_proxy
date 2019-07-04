const http = require('http');
const http2 = require('http2');
const fs = require('fs');
const { URL } = require('url');
const net = require('net');
const progress = require('progress-stream');
const _ = require('lodash');
const { performance } = require('perf_hooks');

let config = Object.assign({
  authenticate: false,
  timestamp: false,
  tunnel_bytes: false,
  response_bytes: false,
}, JSON.parse(fs.readFileSync('proxy-config.json')));

if (config.timestamp) {
  require('console-stamp')(console, { pattern: 'HH:MM:ss.l' });
}

const options = {
  key: fs.readFileSync('http2-cert.key'),
  cert: fs.readFileSync('http2-cert.pem'),
  settings: {
    maxConcurrentStreams: config.maxConcurrentStreams,
  },
};

const proxy = http2.createSecureServer(options);

let session_count = 0;
let session_id = 0;
proxy.on('session', session => {
  session.__id = ++session_id;
  session.__tunnel_count = 0;
  
  ++session_count;
  if (session_count === 1) {
    console.log(`\n\n>>> FIRST SESSION OPENING\n`);
  }
  console.log(`*** NEW SESSION`, session.__id, '( sessions:', session_count, ')');

  session.on('close', () => {
    --session_count;
    console.log(`*** CLOSED SESSION`, session.__id, '( sessions:', session_count, ')');
    if (!session_count) {
      console.log(`\n\n<<< LAST SESSION CLOSED\n`);
    }
  });
});

proxy.on('stream', (stream, headers) => {
  if (headers[':method'] !== 'CONNECT') {
    handle_non_connect(stream, headers)
  } else {
    handle_connect(stream, headers)
  }
});

function authenticated(stream, headers) {
  if (!config.authenticate) {
    return true;
  }

  if ('proxy-authorization' in headers) {
    return true;
  }

  const response = {
    ':status': 407,
  }
  if (typeof config.authenticate == "string") {
    response['proxy-authenticate'] = config.authenticate;
  }

  console.log('  forcing blind authentication', response);
  stream.respond(response);
  stream.end();
  return false;
}

function handle_non_connect(stream, headers) {
  const session = stream.session;
  const uri = new URL(`${headers[':scheme']}://${headers[':authority']}${headers[':path']}`);
  const url = uri.toString();
  const options = {
    protocol: uri.protocol,
    hostname: uri.hostname,
    port: uri.port || 80,
    path: headers[':path'],
    method: headers[':method'],
    headers: _.pick(headers, [
      'accept',
      'accept-encoding',
      'accept-language',
      'cache-control',
      'content-length',
      'content-type',
      'upgrade-insecure-requests',
    ]),
  };

  console.log('REQUEST', url, options);

  // Just for testing how the client behaves when authentication is required
  if (!authenticated(stream, headers)) {
    return;
  }

  console.log('tunnels:', ++session.__tunnel_count, 'on session:', session.__id, '( sessions:', session_count, ')');

  stream.on('close', () => {
    console.log('REQUEST STREAM CLOSED', url);
    console.log('tunnels:', --session.__tunnel_count, 'on session:', session.__id, '( sessions:', session_count, ')');
  });
  stream.on('error', err => {
    console.log('RESPONSE STREAM ERROR', err, url, 'on session:', session.__id);
  });

  const request = http.request(options);
  stream.pipe(request);

  request.on('response', response => {
    const headers = _.omit(response.headers, ['connection', 'transfer-encoding']);
    headers[':status'] = response.statusCode;
    console.log('RESPONSE BEGIN', url, headers, 'on session:', session.__id);

    try {
      stream.respond(headers);

      response.on('data', data => {
        if (config.response_bytes) {
          console.log('RESPONSE DATA', data.length, url);
        }
        stream.write(data);
      });
      response.on('error', err => {
        console.log('RESPONSE ERROR', err, url, 'on session:', session.__id);
        stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);
      });
      response.on('end', () => {
        console.log('RESPONSE END', url, 'on session:', session.__id);
        stream.end();
      });
    } catch (exception) {
      console.log('RESPONSE EXCEPTION', exception, url, 'on session:', session.__id);
      stream.close();
    }
  });  
  request.on('error', error => {
    console.error('REQUEST ERROR', error, url, 'on session:', session.__id);
    try {
      stream.respond({
        ':status': 502, 'content-type': 'application/proxy-explanation+json'
      });
      stream.end(JSON.stringify({
        title: 'request error',
        description: error.toString(),
      }));
    } catch (exception) {
      stream.close();
    }
  });
}

function handle_connect(stream, headers) {
  const session = stream.session;
  const auth_value = headers[':authority'];
  console.log('CONNECT\'ing to', auth_value, 'stream.id', stream.id);

  // Just for testing how the client behaves when authentication is required
  if (!authenticated(stream, headers)) {
    return;
  }

  console.log('  tunnels:', ++session.__tunnel_count, 'on session:', session.__id, '( sessions:', session_count, ')');

  const open_time = performance.now();

  stream.on('close', () => {
    console.log('tunnel stream closed', auth_value, 'stream.id', stream.id, `in ${((performance.now() - open_time) / 1000).toFixed(1)}secs`);
    console.log('  tunnels:', --session.__tunnel_count, 'on session:', session.__id, '( sessions:', session_count, ')');
    socket.end();
  });
  stream.on('error', error => {
    console.log('tunnel stream error', error, auth_value, 'stream.id', stream.id, 'on session:', session.__id);
  });
  stream.on('aborted', () => {
    console.log('tunnel stream aborted', auth_value, 'stream.id', stream.id, 'on session:', session.__id);
    socket.end();
  });

  const auth = new URL(`tcp://${auth_value}`);
  // Strip IPv6 brackets, because Node is trying to resolve '[::]' as a name and fails to.
  const hostname = auth.hostname.replace(/(^\[|\]$)/g, '');
  const socket = net.connect(auth.port, hostname, () => {
    try {
      console.log('CONNECT\'ed to ', auth_value);
      stream.respond({ ':status': 200 });

      if (config.tunnel_bytes) {
        const prog_socket = progress({});
        const prog_stream = progress({});
        prog_socket.on('progress', progress => {
          console.log(`recv ${progress.delta} <- ${auth_value}`, 'stream.id', stream.id, 'on session:', session.__id);
        });
        prog_stream.on('progress', progress => {
          console.log(`sent ${progress.delta} -> ${auth_value}`, 'stream.id', stream.id, 'on session:', session.__id);
        });

        socket.pipe(prog_socket).pipe(stream);
        stream.pipe(prog_stream).pipe(socket);
      } else {
        socket.pipe(stream);
        stream.pipe(socket);
      }

    } catch (exception) {
      console.error(exception);
      socket.end();
    }
  });

  socket.on('error', (error) => {
    console.log('socket error', error, auth_value, 'stream.id', stream.id, 'on session:', session.__id);
    const status = (error.errno == 'ENOTFOUND') ? 404 : 502;
    console.log(`responsing with http_code='${status}'`);
    try {
      stream.respond({ ':status': status });
      stream.end();
    } catch (exception) {
      stream.close(http2.constants.NGHTTP2_STREAM_CLOSED);
    }
  });
  socket.on('close', () => {
    console.log('socket close', auth_value, 'stream.id', stream.id, 'on session:', session.__id);
    stream.close();
  });
  socket.on('end', () => {
    console.log('socket end', auth_value, 'stream.id', stream.id, 'on session:', session.__id);
  });
  socket.on('ready', () => {
    console.log('socket ready', auth_value, 'stream.id', stream.id, 'on session:', session.__id);
  });
}

const listen = (server, port) => {
  return new Promise(resolve => {
    server.listen(port, "0.0.0.0", 200, () => {
      resolve(server.address().port);
    });
  });
}

listen(proxy, 3000).then(port => {
  console.log(`proxy on :${port}`);
});
