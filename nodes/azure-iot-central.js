'use strict';

const PROVISIONING_HOST = 'global.azure-devices-provisioning.net';

module.exports = function (RED) {

    // ─────────────────────────────────────────────────────────────────────────────
    // Config node — holds credentials, reusable across device nodes
    // ─────────────────────────────────────────────────────────────────────────────
    function AzureIoTCentralConfigNode(config) {
        RED.nodes.createNode(this, config);
        this.name        = config.name;
        this.scopeId     = config.scopeid;
        this.deviceId    = config.deviceid;
        this.transport   = config.transport   || 'mqtt';
        this.auth        = config.auth        || 'sas';
        this.certFile    = config.certfile    || '';
        this.certKeyFile = config.certkeyfile || '';
        // this.credentials.primarykey  (encrypted at rest, decrypted at runtime)
        // this.credentials.passphrase  (encrypted at rest, decrypted at runtime)
    }

    RED.nodes.registerType('azure-iot-central-config', AzureIoTCentralConfigNode, {
        credentials: {
            primarykey: { type: 'password' },
            passphrase:  { type: 'password' }
        }
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // Device node — 1 input, 3 outputs
    //   Output 1 : commands received from IoT Central cloud
    //   Output 2 : desired property changes from IoT Central cloud
    //   Output 3 : status / send confirmations / errors
    // ─────────────────────────────────────────────────────────────────────────────
    function AzureIoTCentralDeviceNode(config) {
        RED.nodes.createNode(this, config);

        const node = this;
        const cfg  = RED.nodes.getNode(config.server);

        if (!cfg) {
            node.error('No Azure IoT Central configuration node selected');
            node.status({ fill: 'red', shape: 'ring', text: 'No config' });
            return;
        }

        const commandNames = (config.commands || '')
            .split(/[\n,]+/)
            .map(s => s.trim())
            .filter(Boolean);

        // ── Per-instance state (zero module-level globals) ───────────────────────
        let hubClient      = null;
        let twin           = null;
        let connected      = false;
        let connecting     = false;
        let closed         = false;
        let reconnectTimer = null;
        let reconnectDelay = 2000;
        const MAX_DELAY    = 60000;

        // ── Helpers ──────────────────────────────────────────────────────────────
        const setStatus = (fill, shape, text) => node.status({ fill, shape, text });

        const emitStatus = (topic, payload) =>
            node.send([null, null, { topic, payload }]);

        // ── Cleanup ──────────────────────────────────────────────────────────────
        function cleanup() {
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
            if (hubClient) {
                try { hubClient.removeAllListeners(); hubClient.close(); } catch (_) {}
                hubClient = null;
            }
            twin = null; connected = false; connecting = false;
        }

        // ── Reconnect with exponential backoff ───────────────────────────────────
        function scheduleReconnect() {
            if (closed || reconnectTimer) return;
            const delaySec = Math.round(reconnectDelay / 1000);
            setStatus('yellow', 'ring', `Reconnecting in ${delaySec}s…`);
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                if (!closed) connect();
            }, reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
        }

        // ── Transport factory ────────────────────────────────────────────────────
        function getTransport() {
            switch (cfg.transport) {
                case 'amqp': return require('azure-iot-device-amqp').Amqp;
                case 'http': return require('azure-iot-device-http').Http;
                default:     return require('azure-iot-device-mqtt').Mqtt;
            }
        }

        // ── Security client factory ──────────────────────────────────────────────
        function buildSecurity() {
            if (cfg.auth === 'x509') {
                if (!cfg.certFile || !cfg.certKeyFile) {
                    throw new Error('X.509 auth requires cert file and key file paths in config');
                }
                const fs = require('fs');
                const certOptions = {
                    cert:       fs.readFileSync(cfg.certFile,    'utf-8'),
                    key:        fs.readFileSync(cfg.certKeyFile,  'utf-8'),
                    passphrase: (cfg.credentials && cfg.credentials.passphrase) || ''
                };
                const X509Security = require('azure-iot-security-x509').X509Security;
                return { secClient: new X509Security(cfg.deviceId, certOptions), certOptions };
            }

            const primaryKey = cfg.credentials && cfg.credentials.primarykey;
            if (!primaryKey) throw new Error('SAS auth requires a primary key in config');
            const SymmetricKeySecurityClient = require('azure-iot-security-symmetric-key').SymmetricKeySecurityClient;
            return { secClient: new SymmetricKeySecurityClient(cfg.deviceId, primaryKey), certOptions: null };
        }

        // ── Connect (DPS → Hub) ──────────────────────────────────────────────────
        function connect() {
            if (closed || connected || connecting) return;
            connecting = true;
            setStatus('yellow', 'ring', 'Provisioning…');
            node.log('Starting DPS provisioning');

            const Transport = getTransport();
            let security;
            try {
                security = buildSecurity();
            } catch (err) {
                node.error(`Configuration error: ${err.message}`);
                setStatus('red', 'ring', err.message);
                connecting = false;
                return;
            }

            const ProvisioningDeviceClient = require('azure-iot-provisioning-device').ProvisioningDeviceClient;
            const ProvisioningTransport    = require('azure-iot-provisioning-device-mqtt').Mqtt;

            const provClient = ProvisioningDeviceClient.create(
                PROVISIONING_HOST,
                cfg.scopeId,
                new ProvisioningTransport(),
                security.secClient
            );

            provClient.register((err, result) => {
                if (closed) return;
                if (err) {
                    node.error(`DPS provisioning failed: ${err.message}`);
                    setStatus('red', 'ring', 'DPS failed');
                    connecting = false;
                    scheduleReconnect();
                    return;
                }

                node.log(`DPS OK — hub: ${result.assignedHub}, deviceId: ${result.deviceId}`);
                setStatus('yellow', 'ring', 'Connecting…');

                const { Client } = require('azure-iot-device');
                const connStr = cfg.auth === 'x509'
                    ? `HostName=${result.assignedHub};DeviceId=${result.deviceId};x509=true`
                    : `HostName=${result.assignedHub};DeviceId=${result.deviceId};SharedAccessKey=${cfg.credentials.primarykey}`;

                hubClient = Client.fromConnectionString(connStr, Transport);
                if (cfg.auth === 'x509' && security.certOptions) {
                    hubClient.setOptions(security.certOptions);
                }

                hubClient.on('error', (err) => {
                    node.error(`IoT Hub error: ${err.message}`);
                    setStatus('red', 'dot', 'Error');
                    cleanup();
                    if (!closed) scheduleReconnect();
                });

                hubClient.on('disconnect', () => {
                    node.log('Disconnected from IoT Hub');
                    setStatus('red', 'ring', 'Disconnected');
                    cleanup();
                    if (!closed) scheduleReconnect();
                });

                hubClient.open((err) => {
                    if (closed) return;
                    if (err) {
                        node.error(`Hub connection failed: ${err.message}`);
                        setStatus('red', 'ring', 'Connect failed');
                        cleanup();
                        scheduleReconnect();
                        return;
                    }

                    connected      = true;
                    connecting     = false;
                    reconnectDelay = 2000;
                    setStatus('green', 'dot', 'Connected');
                    node.log(`Connected to ${result.assignedHub}`);
                    emitStatus('connected', { hub: result.assignedHub, deviceId: result.deviceId });

                    if (cfg.transport !== 'http') {
                        registerCommandHandlers();
                        initTwin();
                    }
                });
            });
        }

        // ── Command handlers → output 1 ──────────────────────────────────────────
        //
        // Commands arrive from IoT Central. We emit them as Node-RED messages so
        // the user can wire output 1 into any function node and call:
        //   msg._respond(200, { result: 'ok' })
        // to acknowledge back to the cloud. No flow.set() ceremony required.
        //
        function registerCommandHandlers() {
            commandNames.forEach(name => {
                node.log(`Registering command: ${name}`);

                hubClient.onDeviceMethod(name, (request, response) => {
                    node.log(`Command received: ${name}`);
                    let responded = false;

                    const respond = (statusCode, payload, cb) => {
                        if (responded) {
                            node.warn(`_respond called twice for command "${name}" — ignoring`);
                            return;
                        }
                        responded = true;
                        response.send(statusCode, payload, cb || ((err) => {
                            if (err) node.error(`Command "${name}" response error: ${err.message}`);
                        }));
                    };

                    // IoT Central times out after ~30 s — auto-ACK to prevent dangling request
                    const autoTimer = setTimeout(() => {
                        if (!responded) {
                            node.warn(`Command "${name}" not acknowledged in 30 s — auto-responding 200`);
                            respond(200, { status: 'ack_timeout' });
                        }
                    }, 30000);

                    node.send([{
                        topic:      name,
                        payload:    request.payload,
                        methodName: request.methodName,
                        requestId:  request.requestId,
                        _respond:   (code, payload, cb) => {
                            clearTimeout(autoTimer);
                            respond(code, payload, cb);
                        }
                    }, null, null]);
                });
            });
        }

        // ── Device twin: desired props → output 2 ────────────────────────────────
        function initTwin() {
            hubClient.getTwin((err, deviceTwin) => {
                if (closed) return;
                if (err) {
                    node.warn(`Cannot get device twin: ${err.message}`);
                    return;
                }
                twin = deviceTwin;
                node.log('Device twin ready');

                twin.on('properties.desired', (delta) => {
                    const version  = delta.$version;
                    const changes  = {};
                    const ackPatch = {};

                    for (const k in delta) {
                        if (k === '$version') continue;
                        changes[k]  = delta[k];
                        ackPatch[k] = { value: delta[k], ad: 'success', ac: 200, av: version };
                    }

                    if (Object.keys(changes).length === 0) return;

                    node.send([null, { topic: 'desired', payload: changes, version }, null]);

                    // Auto-acknowledge to IoT Central (required by the twin protocol)
                    twin.properties.reported.update(ackPatch, (err) => {
                        if (err) node.warn(`Desired property ack failed: ${err.message}`);
                    });
                });
            });
        }

        // ── Input handler ─────────────────────────────────────────────────────────
        node.on('input', (msg, send, done) => {
            send = send || node.send.bind(node);
            done = done || (() => {});

            if (!connected) {
                if (!connecting) connect();
                node.warn('Not connected — message dropped; connecting now');
                done();
                return;
            }

            const topic = (msg.topic || '').toLowerCase().trim();

            if (topic === 'reported') {
                sendReported(msg.payload, done);
            } else {
                sendTelemetry(msg, done);
            }
        });

        // ── Send telemetry (device → cloud) ──────────────────────────────────────
        function sendTelemetry(msg, done) {
            const { Message } = require('azure-iot-device');
            const body    = (typeof msg.payload === 'string') ? msg.payload : JSON.stringify(msg.payload);
            const message = new Message(body);
            message.contentType     = 'application/json';
            message.contentEncoding = 'utf-8';

            if (msg.componentName) {
                message.properties.add('$.sub', msg.componentName);
            }
            if (msg.messageId) {
                message.messageId = msg.messageId;
            }

            hubClient.sendEvent(message, (err) => {
                if (err) {
                    node.error(`Telemetry failed: ${err.message}`);
                    emitStatus('error', { operation: 'telemetry', error: err.message });
                    done(err);
                } else {
                    node.log('Telemetry sent');
                    emitStatus('telemetry_sent', { payload: msg.payload });
                    done();
                }
            });
        }

        // ── Update reported properties (device → cloud) ──────────────────────────
        function sendReported(props, done) {
            if (!twin) {
                node.warn('Device twin not available — HTTP transport does not support reported properties');
                done();
                return;
            }
            twin.properties.reported.update(props, (err) => {
                if (err) {
                    node.error(`Reported properties failed: ${err.message}`);
                    emitStatus('error', { operation: 'reported', error: err.message });
                    done(err);
                } else {
                    node.log(`Reported properties updated: ${JSON.stringify(props)}`);
                    emitStatus('reported_sent', { payload: props });
                    done();
                }
            });
        }

        // ── Lifecycle ────────────────────────────────────────────────────────────
        node.on('close', (done) => {
            closed = true;
            cleanup();
            node.status({});
            done();
        });

        // Auto-connect on deploy — no input message required to establish connection
        connect();
    }

    RED.nodes.registerType('azure-iot-central-device', AzureIoTCentralDeviceNode);
};
