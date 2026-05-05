# node-red-azure-iot-central

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A [Node-RED](https://nodered.org) node for connecting devices to **[Azure IoT Central](https://azure.microsoft.com/en-us/products/iot-central)** using the official Azure IoT SDKs. Supports DPS auto-provisioning, telemetry, cloud-to-device commands, and device twin (desired/reported properties) over MQTT, AMQP, or HTTP.

---

## Features

- **DPS auto-provisioning** — register devices automatically through `global.azure-devices-provisioning.net`
- **Persistent connection** with exponential-backoff reconnection (2 s → 60 s)
- **Multiple transports** — MQTT (recommended), AMQP, HTTP
- **Authentication** — SAS Symmetric Key or X.509 certificates
- **Telemetry** — send JSON payloads device → cloud
- **Cloud commands** — receive method invocations from IoT Central with auto-ACK on timeout
- **Device twin** — desired-property delta with automatic version-stamped acknowledgment, plus reported properties
- **IoT Plug and Play** — optional `componentName` for component-scoped telemetry
- **Per-instance state** — multiple device nodes run independent connections

---

## Install

From the Node-RED UI: **Manage palette → Install** and search for `node-red-azure-iot-central`.

Or from the user data directory (`~/.node-red`):

```bash
npm install node-red-azure-iot-central
```

Requires **Node.js ≥ 18** and **Node-RED ≥ 3.0**.

---

## Nodes

### `azure-iot-central-config` (configuration node)

Holds device credentials, reusable across multiple device nodes.

| Field | Description |
|---|---|
| **Scope ID** | DPS ID Scope (IoT Central → Administration → Device connection) |
| **Device ID** | Must match the device registered in IoT Central |
| **Transport** | `mqtt` (default), `amqp`, or `http` |
| **Auth** | `sas` (Symmetric Key) or `x509` (Certificate) |
| **Primary Key** | SAS primary key (encrypted at rest) |
| **Cert File / Key File / Passphrase** | X.509 certificate paths and key passphrase |

### `azure-iot-central-device`

Maintains the persistent connection. **1 input, 3 outputs.**

| Port | Direction | Purpose |
|---|---|---|
| Input | flow → cloud | Telemetry or reported properties |
| Output 1 | cloud → flow | Commands received from IoT Central |
| Output 2 | cloud → flow | Desired-property changes |
| Output 3 | flow → flow | Status events (`connected`, `telemetry_sent`, `reported_sent`, `error`) |

---

## Usage

### 1. Send telemetry

Wire any node (e.g. `inject`, `function`) into the input. Default `msg.topic` is `telemetry`.

```javascript
msg.payload = { temperature: 22.5, humidity: 47 };
return msg;
```

Optional fields:

| Property | Type | Notes |
|---|---|---|
| `msg.topic` | string | `telemetry` (default) or `reported` |
| `msg.payload` | object \| string | Telemetry data or reported-properties patch |
| `msg.componentName` | string | IoT Plug and Play component name (`$.sub`) |
| `msg.messageId` | string | IoT Hub message ID |

### 2. Update reported properties

```javascript
msg.topic   = 'reported';
msg.payload = { firmwareVersion: '1.4.2', uptime: 3600 };
return msg;
```

> Reported properties require **MQTT or AMQP** — HTTP transport is telemetry-only.

### 3. Handle cloud commands (Output 1)

In the device node config, list the command names (one per line). Wire **Output 1** into a `function` node and call `msg._respond(statusCode, payload)` to acknowledge:

```javascript
if (msg.methodName === 'reboot') {
    // do work...
    msg._respond(200, { status: 'rebooting' });
}
return null; // do not forward downstream
```

If you do not respond within **30 seconds**, the node auto-ACKs with status `200` and payload `{ status: 'ack_timeout' }` to prevent hung requests on the IoT Central side.

### 4. React to desired-property changes (Output 2)

```javascript
// msg.topic   === 'desired'
// msg.payload === { setpoint: 21, mode: 'auto' }
// msg.version === <twin version>
```

Acknowledgment back to IoT Central is **automatic** — each property is reported with `{ value, ad: 'success', ac: 200, av: <version> }`.

### 5. Monitor status (Output 3)

```text
{ topic: 'connected',      payload: { hub, deviceId } }
{ topic: 'telemetry_sent', payload: { payload } }
{ topic: 'reported_sent',  payload: { payload } }
{ topic: 'error',          payload: { operation, error } }
```

---

## Example flow

```json
[
  {"id":"f1","type":"tab","label":"IoT Central","disabled":false,"info":""},
  {"id":"i1","type":"inject","z":"f1","name":"every 30s","props":[{"p":"payload"}],"repeat":"30","payload":"{\"temperature\":22.5}","payloadType":"json","x":160,"y":120,"wires":[["d1"]]},
  {"id":"d1","type":"azure-iot-central-device","z":"f1","name":"Device","server":"cfg1","commands":"reboot\nfirmwareUpdate","x":380,"y":160,"wires":[["cmd"],["desired"],["status"]]},
  {"id":"cmd","type":"debug","z":"f1","name":"Command","active":true,"x":600,"y":120,"wires":[]},
  {"id":"desired","type":"debug","z":"f1","name":"Desired","active":true,"x":600,"y":160,"wires":[]},
  {"id":"status","type":"debug","z":"f1","name":"Status","active":true,"x":600,"y":200,"wires":[]},
  {"id":"cfg1","type":"azure-iot-central-config","name":"my-device-01","scopeid":"0ne00000000","deviceid":"my-device-01","transport":"mqtt","auth":"sas"}
]
```

Replace `scopeid`, `deviceid`, and the SAS primary key (set in the config node UI) with values from your IoT Central application.

---

## Transport feature matrix

| Feature | MQTT | AMQP | HTTP |
|---|:---:|:---:|:---:|
| Telemetry | ✓ | ✓ | ✓ |
| Cloud commands | ✓ | ✓ | ✗ |
| Reported properties | ✓ | ✓ | ✗ |
| Desired properties | ✓ | ✓ | ✗ |
| DPS provisioning | ✓ | ✓ | ✓ |

MQTT is the default and recommended transport.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Status `DPS failed` | Wrong Scope ID, wrong Device ID, or wrong primary key |
| Status `Connect failed` after DPS OK | Device disabled in IoT Central, or wrong key signature |
| Repeated `Reconnecting in Ns…` | Network issue or invalid credentials — check Node-RED debug log |
| Commands never arrive | HTTP transport selected, or command names not listed in the device node |
| `Reported properties not available` warning | HTTP transport — switch to MQTT/AMQP |

Enable verbose logging by setting Node-RED's log level to `debug` in `settings.js`.

---

## Contributing

Issues and pull requests are welcome on [GitHub](https://github.com/Warrio111/node-red-azure-iot-central).

---

## License

[MIT](LICENSE) © Robert Benavides
