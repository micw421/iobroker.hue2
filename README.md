# ioBroker.hue2

A new ioBroker adapter for Philips Hue based exclusively on the Hue API v2.

## Goals

- Hue API v2 only
- Stable UUID-based ioBroker object IDs
- No `node-hue-api`
- Resource-oriented internal model
- Event stream as the primary source for live updates
- Clear separation between physical devices, rooms, zones, scenes and entertainment resources

## Current milestone

The first milestone is intentionally small:

1. Start the ioBroker adapter
2. Connect to a configured Hue Bridge
3. Call `GET /clip/v2/resource`
4. Log the discovered v2 resources

Object creation and event stream handling will follow after the resource model is defined.

## Development

```bash
npm install
npm run check
npm run build
```

The adapter currently expects the Hue Bridge address and application key in the instance configuration as `bridge` and `applicationKey`.
