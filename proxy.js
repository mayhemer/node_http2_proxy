const http = require('http');
const https = require('https');
const http2 = require('http2');
const fs = require('fs');
const { URL } = require('url');
const net = require('net');
const progress = require('progress-stream');
const _ = require('lodash');
const { performance } = require('perf_hooks');
const converter = require('hex2dec');

let config = Object.assign({
  authenticate: false,
  timestamp: false,
  tunnel_bytes: false,
  response_bytes: false,
  maxConcurrentStreams: 250,
  enableConnectProtocol: true,
}, JSON.parse(fs.readFileSync('proxy-config.json')));

if (config.timestamp) {
  require('console-stamp')(console, { pattern: 'HH:MM:ss.l' });
}


function authenticated(headers) {
  if (!config.authenticate) {
    return true;
  }

  if ('proxy-authorization' in headers) {
    return true;
  }

  console.log('  forcing blind authentication');
  return false;
}

function respond_407_stream(stream) {
  const response = {
    ':status': 407,
  }
  if (typeof config.authenticate == "string") {
    response['proxy-authenticate'] = config.authenticate;
  }

  stream.respond(response);
  stream.end('Authentication required by the proxy; this line was sent by the proxy.');
}

function respond_407_response(response) {
  const headers = {};
  if (typeof config.authenticate == "string") {
    headers['proxy-authenticate'] = config.authenticate;
  }

  response.writeHead(407, "Proxy unauthenticated", headers);
  response.end();
}

function respond_407_socket(socket) {
  socket.write(
    'HTTP/1.1 407 Proxy unauthenticated\r\n' +
    (typeof config.authenticate == "string"
      ? `proxy-authenticate: ${config.authenticate}\r\n`
      : '') +
    '\r\n');  
  socket.end();
}


const secure_server_options = {
  key: fs.readFileSync('http2-cert.key'),
  cert: fs.readFileSync('http2-cert.pem'),
};

const h2_options = Object.assign({
  settings: {
    maxConcurrentStreams: config.maxConcurrentStreams,
    enableConnectProtocol: config.enableConnectProtocol,
  },
}, secure_server_options);

const h2proxy = http2.createSecureServer(h2_options);
const h1proxy = config.http1_secured
  ? https.createServer(secure_server_options)
  : http.createServer({});

let session_count = 0;
let session_id = 0;
h2proxy.on('session', session => {
  session.__id = ++session_id;
  session.__tunnel_count = 0;
  
  ++session_count;
  if (session_count === 1) {
    console.log(`\n\n>>> FIRST SESSION OPENING\n`);
  }
  console.log(`*** NEW SESSION`, session.__id, '( sessions:', session_count, ')');

  session.on('error', error => {
    console.error('SESSION ERROR', session.__id, error);
  });  
  session.on('close', () => {
    --session_count;
    console.log(`*** CLOSED SESSION`, session.__id, '( sessions:', session_count, ')');
    if (!session_count) {
      console.log(`\n\n<<< LAST SESSION CLOSED\n`);
    }
  });
});

h2proxy.on('stream', (stream, headers) => {
  if (headers[':method'] !== 'CONNECT') {
    handle_h2_non_connect(stream, headers)
  } else {
    handle_h2_connect(stream, headers)
  }
});

h2proxy.on('error', error => {
  console.error('!!! proxy error', error);
});

h2proxy.on('unknownProtocol', client_socket => {
  if (config.http1_secured) {
    console.error('`unknownProtocol`, plain HTTP/1 proxy not available to pipe through, closing', '|', 'client>proxy port:', client_socket.remotePort);
    client_socket.destroy();
    return;
  }

  console.log('`unknownProtocol`, pipe through HTTP/1 proxy', '|', 'client>proxy port:', client_socket.remotePort);
  const piping_socket = net.connect(3001, '127.0.0.1', () => {
    console.log('h2->h1 pipe socket created', '|', 'client>proxy port:', client_socket.remotePort, 'proxy>h1 port:', piping_socket.localPort);
    piping_socket.pipe(client_socket);
    client_socket.pipe(piping_socket);
  });

  piping_socket.on('error', (error) => {
    client_socket.destroy(error);
  });
  client_socket.on('error', (error) => {
    piping_socket.destroy(error);
  });
  client_socket.on('close', () => {
    console.log('`unknownProtocol` client socket closed', '|', 'client>proxy port:', client_socket.remotePort);
  });
});

function handle_h2_non_connect(stream, headers) {
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
      'cookie',
      'upgrade-insecure-requests',
    ]),
  };

  console.log('REQUEST', url, options);

  if (uri.protocol === 'https:') {
    console.error('unsupported');
    stream.respond({ ':status': 500 });
    stream.end('I accept only CONNECT');
    return;
  }

  // Just for testing how the client behaves when authentication is required
  if (!authenticated(headers)) {
    respond_407_stream(stream);
    return;
  }

  console.log('  tunnels:', ++session.__tunnel_count, 'on session:', session.__id, '( sessions:', session_count, ')');

  stream.on('close', () => {
    console.log('REQUEST STREAM CLOSED', url);
    console.log('  tunnels:', --session.__tunnel_count, 'on session:', session.__id, '( sessions:', session_count, ')');
  });
  stream.on('error', error => {
    console.log('RESPONSE STREAM ERROR', error, url, 'on session:', session.__id);
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
      response.on('error', error => {
        console.log('RESPONSE ERROR', error, url, 'on session:', session.__id);
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

function handle_h2_connect(stream, headers) {
  const session = stream.session;
  const session_socket = session.socket;
  const auth_value = headers[':authority'];
  console.log('CONNECT\'ing to', auth_value, 'stream.id', converter.decToHex(stream.id.toString()), '|', 'client>proxy port:', session_socket.remotePort);

  // Just for testing how the client behaves when authentication is required
  if (!authenticated(headers)) {
    respond_407_stream(stream);
    return;
  }

  console.log('  tunnels:', ++session.__tunnel_count, 'on session:', session.__id, '( sessions:', session_count, ')');

  const open_time = performance.now();

  const auth = new URL(`tcp://${auth_value}`);
  // Strip IPv6 brackets, because Node is trying to resolve '[::]' as a name and fails to.
  const hostname = auth.hostname.replace(/(^\[|\]$)/g, '');
  const server_socket = net.connect(auth.port, hostname, () => {
    try {
      console.log('CONNECT\'ed to ', auth_value, 'stream.id', converter.decToHex(stream.id.toString()), '|', 'client>proxy port:', session_socket.remotePort, 'proxy>server port:', server_socket.localPort);
      stream.respond({ ':status': 200 });

      if (config.tunnel_bytes) {
        const prog_socket = progress({});
        const prog_stream = progress({});
        prog_socket.on('progress', progress => {
          console.log(`recv ${progress.delta} <- ${auth_value}`, 'stream.id', converter.decToHex(stream.id.toString()), 'on session:', session.__id);
        });
        prog_stream.on('progress', progress => {
          console.log(`sent ${progress.delta} -> ${auth_value}`, 'stream.id', converter.decToHex(stream.id.toString()), 'on session:', session.__id);
        });

        server_socket.pipe(prog_socket).pipe(stream);
        stream.pipe(prog_stream).pipe(server_socket);
      } else {
        server_socket.pipe(stream);
        stream.pipe(server_socket);
      }

    } catch (exception) {
      console.error(exception);
      server_socket.end();
    }
  });

  server_socket.on('error', (error) => {
    console.log('socket error', error, auth_value, 'stream.id', converter.decToHex(stream.id.toString()), 'on session:', session.__id);
    const status = (error.errno == 'ENOTFOUND') ? 404 : 502;
    console.log(`responsing with http_code='${status}'`);
    try {
      stream.respond({ ':status': status });
      stream.end();
    } catch (exception) {
      stream.close(http2.constants.NGHTTP2_STREAM_CLOSED);
    }
  });
  server_socket.on('close', () => {
    console.log('socket close', auth_value, 'stream.id', converter.decToHex(stream.id.toString()), 'on session:', session.__id);
    stream.close();
  });
  server_socket.on('end', () => {
    console.log('socket end', auth_value, 'stream.id', converter.decToHex(stream.id.toString()), 'on session:', session.__id);
  });
  server_socket.on('ready', () => {
    console.log('socket ready', auth_value, 'stream.id', converter.decToHex(stream.id.toString()), 'on session:', session.__id);
  });

  stream.on('close', () => {
    console.log('tunnel stream closed', auth_value, 'stream.id', converter.decToHex(stream.id.toString()), `in ${((performance.now() - open_time) / 1000).toFixed(1)}secs`);
    console.log('  tunnels:', --session.__tunnel_count, 'on session:', session.__id, '( sessions:', session_count, ')');
    server_socket.end();
  });
  stream.on('error', error => {
    console.log('tunnel stream error', error, auth_value, 'stream.id', converter.decToHex(stream.id.toString()), 'on session:', session.__id);
  });
  stream.on('aborted', () => {
    console.log('tunnel stream aborted', auth_value, 'stream.id', converter.decToHex(stream.id.toString()), 'on session:', session.__id);
    server_socket.end();
  });
}

h1proxy.on('connect', (request, client_socket, head) => {
  handle_h1_connect(request, client_socket, head);
});
h1proxy.on('request', (request, response) => {
  handle_h1_non_connect(request, response);
});

let h1_tunnel_count = 0;
function handle_h1_connect(client_request, client_socket, head) {
  const auth_value = client_request.headers.host;

  console.log('CONNECT\'ing (HTTP/1) to', auth_value, 'proxy>h1 port:', client_request.socket.remotePort);
  console.log('  tunnels (HTTP/1):', ++h1_tunnel_count);

  // Just for testing how the client behaves when authentication is required
  if (!authenticated(client_request.headers)) {
    respond_407_socket(client_socket);
    return;
  }

  const open_time = performance.now();

  const auth = new URL(`tcp://${auth_value}`);
  // Strip IPv6 brackets, because Node is trying to resolve '[::]' as a name and fails to.
  const hostname = auth.hostname.replace(/(^\[|\]$)/g, '');
  const server_socket = net.connect(auth.port, hostname, () => {
    try {
      console.log('CONNECT\'ed (HTTP/1) to ', auth_value, '|', 'h1>server port:', server_socket.localPort);
      client_socket.write(
        'HTTP/1.1 200 Connected\r\n' +
        'Proxy-agent: mayhemer-http1\r\n' +
        '\r\n');
      
      server_socket.write(head);
      
      if (config.tunnel_bytes) {
        const prog_socket = progress({});
        const prog_stream = progress({});
        prog_socket.on('progress', progress => {
          console.log(`recv ${progress.delta} <- ${auth_value}`);
        });
        prog_stream.on('progress', progress => {
          console.log(`sent ${progress.delta} -> ${auth_value}`);
        });

        server_socket.pipe(prog_socket).pipe(client_socket);
        client_socket.pipe(prog_stream).pipe(server_socket);
      } else {
        server_socket.pipe(client_socket);
        client_socket.pipe(server_socket);
      }

    } catch (exception) {
      console.error(exception);
      server_socket.end();
      client_socket.end();
    }
  });

  server_socket.on('error', error => {
    console.log('server socket error', error, auth_value);
    client_socket.destroy(error);
  });
  server_socket.on('close', () => {
    console.log('server socket close', auth_value, `in ${((performance.now() - open_time) / 1000).toFixed(1)}secs`);
    client_socket.end();
  });

  client_socket.on('error', error => {
    console.log('HTTP/1 connect tunnel error', error, auth_value);
    server_socket.destroy(error);
  });
  client_socket.on('close', () => {
    console.log('HTTP/1 connect tunnel closed', auth_value);
    console.log('  tunnels (HTTP/1):', --h1_tunnel_count);
    server_socket.end();
  });
}

function handle_h1_non_connect(client_request, client_response) {
  const url = client_request.url
  const socket = client_request.socket;
  console.log('REQUEST (HTTP/1)', client_request.method, url, 'proxy>h1 port:', socket.remotePort);

  if (!authenticated(client_request.headers)) {
    respond_407_response(client_response);
    return;
  }

  const forward_request = {
    'method': client_request.method,
    'headers': _.omit(client_request.headers, ['proxy-authorization',]),
  };
  const server_request = http.request(url, forward_request);
  
  client_request.on('data', data => {
    if (config.response_bytes || client_request.method == 'POST') {
      console.log('REQUEST (HTTP/1) DATA', data.length, url);
    }
    server_request.write(data);
  });
  client_request.on('end', () => {
    console.log('REQUEST (HTTP/1) END', url);
    server_request.end();
  });

  server_request.on('response', server_response => {
    const headers = _.omit(server_response.headers, ['connection', 'transfer-encoding']);
    console.log('RESPONSE (HTTP/1) BEGIN', url);
    client_response.writeHead(server_response.statusCode, server_response.statusMessage, headers);

    try {
      server_response.on('data', data => {
        if (config.response_bytes) {
          console.log('RESPONSE (HTTP/1) DATA', data.length, url);
        }
        client_response.write(data);
      });
      server_response.on('error', error => {
        console.log('RESPONSE (HTTP/1) ERROR', error, url);
        client_response.end();
      });
      server_response.on('end', () => {
        console.log('RESPONSE (HTTP/1) END', url);
        client_response.end();
        server_response.destroy();
      });
    } catch (exception) {
      console.log('RESPONSE (HTTP/1) EXCEPTION', url);
      client_response.end();
    }
  });
  server_request.on('error', error => {
    console.error('REQUEST (HTTP/1) ERROR', error, client_request.url);

    try {
      client_response.writeHead(502, { 'Content-Type': 'text/plain' });
      client_response.end(error.toString());
    } catch (exception) {
      client_response.end();
    }
  });
}

const listen = (server, listening_address, port) => {
  return new Promise(resolve => {
    server.listen(port, listening_address, 200, () => {
      resolve(server.address().port);
    });
  });
}

if (config.http1_secured) {
  listen(h1proxy, "0.0.0.0", 3000).then(h1_port => {
    console.log(`HTTPS/1 proxy on :${h1_port}`);
  });
} else {
  listen(h1proxy, "127.0.0.1", 3001).then(() => {
    listen(h2proxy, "0.0.0.0", 3000).then(h2_port => {
      console.log(`HTTP/2 proxy on :${h2_port}`);
    });
  });
}
