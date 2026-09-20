# ioBroker.hue2

A new ioBroker adapter for Philips Hue based exclusively on the Hue API v2.

## Goals

- Hue API v2 only
- Stable UUID-based ioBroker object IDs
- No `node-hue-api`
- Resource-oriented internal model
- Hue v2 event stream as the primary source for live updates
- Clear separation between physical devices, rooms, zones, scenes and entertainment resources

## Current state

The adapter connects directly to a Hue Bridge using the Hue API v2, discovers the available resources and creates a user-friendly ioBroker object tree. Live changes from the bridge are received through the Hue v2 event stream.

The visible object structure deliberately follows physical devices and Hue groups instead of exposing the raw Hue service hierarchy.

## Object structure

### Devices

Physical Hue devices are created below:

```text
hue2.0.devices.<device UUID>
```

Depending on the capabilities of the device, states can include:

```text
on
dimming
color_temperature
color
command
transition_active
entertainment_active
motion
temperature
light_level
battery_level
battery_state
connected
info.*
```

Not every state is created for every device. For example, `color` is only available for lights that expose Hue color support.

### Rooms and zones

Hue rooms and zones are created below:

```text
hue2.0.rooms.<room UUID>
hue2.0.zones.<zone UUID>
```

A room or zone can expose states such as:

```text
name
active_scene
all_on
on
dimming
color_temperature
color
command
transition_active
entertainment_active
lights.*
scenes.*
```

## Important states

### `command`

`command` provides direct access to Hue API v2 commands. The value is a JSON string containing the body that is sent to the corresponding Hue resource.

For example, switch on and set brightness:

```json
{
  "on": {
    "on": true
  },
  "dimming": {
    "brightness": 50
  }
}
```

A transition can be requested with Hue `dynamics.duration`:

```json
{
  "dimming": {
    "brightness": 80
  },
  "dynamics": {
    "duration": 3000
  }
}
```

Relative dimming is also possible. The following command dims upwards over five seconds and can be interrupted with a stop command:

```json
{
  "dimming_delta": {
    "action": "up",
    "brightness_delta": 100
  },
  "dynamics": {
    "duration": 5000
  }
}
```

Stop the running dim operation:

```json
{
  "dimming_delta": {
    "action": "stop"
  }
}
```

The `command` state is useful for Hue v2 features that do not have a dedicated ioBroker state. Dedicated states such as `on`, `dimming` and `color_temperature` should normally be preferred for simple changes.

### `transition_active`

`transition_active` indicates transitions started through this adapter using a `command` containing `dynamics.duration`.

The state is set to `true` when such a transition starts and returns to `false` when its configured duration expires. A subsequent write that replaces or stops the transition also clears the state.

For room and zone commands, the state is tracked both on the group and on its contained light devices.

This is a locally tracked adapter state. Hue does not provide a reliable general-purpose "transition currently active" state through the v2 event stream. Therefore transitions started outside this adapter, for example in the Hue app, are not necessarily represented by `transition_active`.

### `entertainment_active`

`entertainment_active` indicates whether the light or group is currently involved in an active Hue Entertainment configuration.

The state is only created where an entertainment relationship exists. It is independent of the normal `on` state: a light being controlled by Hue Entertainment does not cause the adapter to overwrite its regular `on` value.

### Entertainment configurations

Hue Entertainment configurations are exposed as their own top-level resources:

```text
hue2.0.entertainment.<configuration UUID>
├─ name
├─ active
├─ start
└─ stop
```

`active` is a read-only status derived from the Hue `entertainment_configuration.status`.

`start` and `stop` are button states. Writing `true` sends the corresponding Hue v2 Entertainment action to that configuration; the button is then reset to `false`. Changes to the actual Entertainment status are received through the Hue event stream.

The existing `entertainment_active` states on devices, rooms and zones remain read-only convenience indicators. To stop an active Entertainment session, use the `stop` state of the corresponding entry below `entertainment`.

### `lights`

Rooms and zones contain a `lights` channel listing their member lights:

```text
hue2.0.rooms.<room UUID>.lights.<device UUID>
hue2.0.zones.<zone UUID>.lights.<device UUID>
```

Each state uses the physical Hue device UUID as its ID and contains the light's name as its value. This makes it possible for ioBroker scripts to discover all light devices belonging to a room or zone without having to know Hue service UUIDs.

Example:

```javascript
const roomLights = 'hue2.0.rooms.<room UUID>.lights';

const lightIds = $(roomLights + '.*')
    .toArray()
    .map(id => id.split('.').pop());
```

To build the corresponding device paths:

```javascript
const lights = $(roomLights + '.*')
    .toArray()
    .map(id => {
        const uuid = id.split('.').pop();
        return `hue2.0.devices.${uuid}`;
    });
```

### `active_scene` and scenes

Scenes belonging to a room or zone are exposed below:

```text
rooms.<room UUID>.scenes.<scene UUID>
zones.<zone UUID>.scenes.<scene UUID>
```

A scene provides its name, current Hue status and a writable `recall` state.

`active_scene` contains the name of the currently active scene. If no scene is active, it is an empty string.

### `all_on`

`all_on` is true when all lights belonging to the room or zone are on.

There is intentionally no separate `any_on` state. Hue API v2 `grouped_light.on.on` already represents the group's effective on state and is exposed as `on`.

### `connected`

Where a Hue `zigbee_connectivity` resource exists, `connected` exposes the connection state as a boolean:

- `true`: Hue reports `connected`
- `false`: any other connectivity status

## UUID-based IDs

Hue API v2 resource UUIDs are used for ioBroker object IDs. This avoids the numeric v1 sensor and light IDs and keeps IDs stable.

For physical devices, Hue service UUIDs are intentionally hidden from the normal ioBroker path. The adapter internally maps services such as `light`, `motion`, `temperature` and `light_level` to their owning physical device.

## Event stream

After the initial resource discovery, the adapter uses the Hue API v2 event stream for live updates. Incoming partial resource updates are merged into the internal resource model and reflected in the corresponding ioBroker states.

## Configuration

The adapter expects the Hue Bridge address and Hue application key in the instance configuration:

- `bridge`
- `applicationKey`
- `dimmingControlsPower` (default: `false`): if enabled, writing `dimming > 0` also turns the light or group on. Writing `dimming = 0` turns it off. With this option disabled, `dimming` only changes brightness and does not implicitly change the power state.

The `dimmingControlsPower` option only affects direct writes to the `dimming` state. Raw JSON written to `command` is sent as specified and is not modified by this option.

## Development

```bash
npm install
npm run check
npm run build
```
