const http = require('http');
const http2 = require('http2');
const fs = require('fs');
const { URL } = require('url');
const net = require('net');
const progress = require('progress-stream');
const _ = require('lodash');

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
  console.log(`*** NEW SESSION`, session.__id, '( sessions:', session_count, ')');

  session.on('close', () => {
    --session_count;
    console.log(`*** CLOSED SESSION`, session.__id, '( sessions:', session_count, ')');
  });
});

function handle_non_connect(stream, headers) {
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
  console.log('tunnels:', ++session.__tunnel_count, 'on session:', session.__id, '( sessions:', session_count, ')');

  stream.on('close', () => {
    console.log('REQUEST STREAM CLOSED', url);
    console.log('tunnels:', --session.__tunnel_count, 'on session:', session.__id, '( sessions:', session_count, ')');
    socket.end();
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
  const auth_value = headers[':authority'];
  const session = stream.session;
  console.log('CONNECT\'ing to', auth_value, 'stream.id', stream.id);

  // Just for testing how the client behaves when authentication is required
  if (config.authenticate && !('proxy-authorization' in headers)) {
    console.log('forcing blind authentication');
    stream.respond({ ':status': 407, 'proxy-authenticate': 'basic realm="You cannot pass!"' });
    stream.end();
    return;
  }

  console.log('  tunnels:', ++session.__tunnel_count, 'on session:', session.__id, '( sessions:', session_count, ')');

  stream.on('close', () => {
    console.log('tunnel stream closed', auth_value, 'stream.id', stream.id);
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
          console.log(`recv ${progress.delta} <- ${auth_value}`);
        });
        prog_stream.on('progress', progress => {
          console.log(`sent ${progress.delta} -> ${auth_value}`);
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

proxy.on('stream', (stream, headers) => {
  if (headers[':method'] !== 'CONNECT') {
    handle_non_connect(stream, headers)
  } else {
    handle_connect(stream, headers)
  }
});

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
