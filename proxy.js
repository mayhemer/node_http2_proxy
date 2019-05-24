const http = require('http');
const http2 = require('http2');
const fs = require('fs');
const { URL } = require('url');
const net = require('net');
const _ = require('lodash');

const options = {
  key: fs.readFileSync('http2-cert.key'),
  cert: fs.readFileSync('http2-cert.pem'),
};

const proxy = http2.createSecureServer(options);

let session_count = 0;
proxy.on('session', (session) => {
  ++session_count;
  console.log(`\nsession #${session_count}\n`);
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
  const request = http.request(options, response => {
    const headers = _.omit(response.headers, ['connection']);
    headers[':status'] = response.statusCode;
    console.log('RESPONSE BEGIN', url, headers);

    try {
      stream.respond(headers);

      response.on('data', data => {
        stream.write(data);
      });
      response.on('end', () => {
        console.log('RESPONSE END', url);
        stream.end();
      });
    } catch (exception) {
      stream.close();
    }
  });
  
  request.on('error', (error) => {
    console.error('request error', url, error);
  });

  stream.pipe(request);
}


function handle_connect(stream, headers) {
  const auth_value = headers[':authority'];
  console.log('CONNECT\'ing to', auth_value);

  // Just for testing how the client behaves when authentication is required
  const REQUIRE_AUTHENTICATION = false;

  if (REQUIRE_AUTHENTICATION && !('proxy-authorization' in headers)) {
    console.log('forcing blind authentication');
    stream.respond({ ':status': 407, 'proxy-authenticate': 'basic realm="You cannot pass!"' });
    stream.end();
    return;
  }

  const auth = new URL(`tcp://${auth_value}`);
  const socket = net.connect(auth.port, auth.hostname, () => {
    try {
      console.log('CONNECT\'ed to ', auth_value);
      stream.respond({ ':status': 200 });
      socket.pipe(stream);
      stream.pipe(socket);
    } catch (exception) {
      console.error(exception);
    }
  });

  socket.on('error', (error) => {
    console.log('socket error', error, auth_value);
    try {
      stream.respond({ ':status': 502 });
      stream.end();
    } catch (exception) {
      stream.close(http2.constants.NGHTTP2_STREAM_CLOSED);
    }
  });
  socket.on('close', () => {
    console.log('socket close', auth_value);
  });
  socket.on('end', () => {
    console.log('socket end', auth_value);
  });
  socket.on('ready', () => {
    console.log('socket ready', auth_value);
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
