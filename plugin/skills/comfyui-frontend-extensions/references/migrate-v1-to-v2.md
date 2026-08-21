# Migrating v1 → v2 frontend extensions

Maps legacy patterns (`app.registerExtension()`, `nodeType.prototype` patching,
`api.addEventListener`, `widget.callback`) to their `@comfyorg/extension-api` v2
equivalents. See [`../SKILL.md`](../SKILL.md) for full authoring patterns.

## Contents

- [The big picture](#the-big-picture): what v2 split apart, and why
- [Top-level registration](#top-level-registration): `registerExtension` → `defineExtension`
- [Lifecycle hooks](#lifecycle-hooks): `setup`/`init` → `onLoad`/`onUnload`
- [Node prototype patching → `NodeHandle` events](#node-prototype-patching--nodehandle-events)
- [Widgets](#widgets): `addWidget`/`widget.callback` → typed widget handles
- [Events: `api.addEventListener` → typed namespaces](#events-apiaddeventlistener--typed-namespaces)
- [Shell UI](#shell-ui): sidebar tabs, commands, keybindings, settings, toasts
- [Cleanup / teardown](#cleanup--teardown): disposers replace manual unpatching
- [Migration checklist](#migration-checklist): the ordered pass to run over an extension

## The big picture

v1 packed everything into a single `app.registerExtension({...})` mega-call with
mixed concerns (node patching, commands, keybindings, settings, UI). v2 splits each
concern into its own `defineX`, each independently importable, testable, and disposable.

```ts
// ── v1 ──────────────────────────────────────────────────────────────────
import { app } from '../../scripts/app.js'

app.registerExtension({
  name: 'MyExt',
  async init() { /* early */ },
  async setup() { /* late, app ready */ },
  async beforeRegisterNodeDef(nodeType, nodeData, app) { /* filter + patch */ },
  nodeCreated(node) { /* per-instance */ },
  loadedGraphNode(node) { /* per-instance from saved workflow */ },
  commands: [/* ... */],
  keybindings: [/* ... */],
  settings: [/* ... */],
  aboutPageBadges: [/* ... */]
})
```

```ts
// ── v2 ──────────────────────────────────────────────────────────────────
import {
  defineNode, defineExtension, defineCommand,
  defineHotkey, defineSetting, defineAboutBadge
} from '@comfyorg/extension-api'

// One default export per file is conventional; or call defineX at module scope.
export default defineNode({
  name: 'my-org.my-ext',
  nodeTypes: ['MyNode'],          // replaces beforeRegisterNodeDef filtering
  nodeCreated(node) { /* ... */ },
  loadedGraphNode(node) { /* ... */ }
})

// Each shell-UI concern is its own call:
defineCommand({ id: 'my-org.cmd', function: () => {} })
defineHotkey({ keys: 'mod+k', commandId: 'my-org.cmd' })
defineSetting({ id: 'my-org.opt' as never, name: 'My Option', type: 'boolean', defaultValue: false })
defineAboutBadge({ label: 'Docs', url: 'https://…', icon: 'pi-book' })
```

## Top-level registration

| v1 | v2 |
|----|----|
| `app.registerExtension({ name, ... })` | Split into `defineNode` / `defineExtension` + per-surface `defineX` |
| `import { app } from '../../scripts/app.js'` | `import { defineExtension, ... } from '@comfyorg/extension-api'` |
| Single object, mixed concerns | One `defineX` per concern, each returns a `DisposableHandle` |

## Lifecycle hooks

| v1 | v2 |
|----|----|
| `init()` | `defineExtension({ setup() {...} })` — the `setup()` body runs at the early `init` point |
| `setup()` (fires after core extensions ready) | `setup() { onMounted(() => {...}) }` — late work goes in the imported `onMounted` hook |
| `nodeCreated(node)` | `defineNode({ nodeCreated(node) {...} })` |
| `loadedGraphNode(node)` | `defineNode({ loadedGraphNode(node) {...} })` |
| `beforeRegisterNodeDef(nodeType, nodeData)` filtering | `defineNode({ nodeTypes: ['Foo', 'Bar'] })` |

> Both `init` and `setup` survive as `ExtensionOptions` fields for back-compat but are
> deprecated. Move `init` bodies into `setup()`; move late `setup` work into
> `onMounted(() => …)` inside `setup()`. A codemod ships in the package.

```ts
// v1
app.registerExtension({
  name: 'X',
  setup() { api.addEventListener('execution_start', onStart) }
})

// v2
defineExtension({
  name: 'X',
  setup() { onMounted(() => execution.on('start', onStart)) }
})
```

## Node prototype patching → `NodeHandle` events

The most common v1 anti-pattern was patching `nodeType.prototype.*`. v2 replaces all of
it with typed `node.on(...)` subscriptions inside `defineNode`.

| v1 prototype patch | v2 |
|--------------------|----|
| `nodeType.prototype.onExecuted = function(msg) {...}` | `node.on('executed', (e) => {... e.output ...})` |
| `nodeType.prototype.onRemoved = function() {...}` | `node.on('removed', fn)` or `onNodeRemoved(fn)` |
| `nodeType.prototype.onConfigure = function() {...}` | `node.on('configured', fn)` or `defineNode({ loadedGraphNode })` |
| `nodeType.prototype.onNodeCreated = function() {...}` | `defineNode({ nodeCreated(node) {...} })` |
| `nodeType.prototype.onDrawForeground = ...` | Deferred in Phase A — not yet on the v2 surface |
| `nodeType.prototype.serialize = ...` | Widget-level `widget.on('beforeSerialize', fn)` |
| `const orig = proto.onX; proto.onX = function(){ orig?.apply(this, arguments); ... }` | Just call `node.on('x', fn)` — multiple extensions compose without chaining originals |

```ts
// v1
const onExecuted = nodeType.prototype.onExecuted
nodeType.prototype.onExecuted = function (message) {
  onExecuted?.apply(this, arguments)
  this.widgets.find(w => w.name === 'preview').value = message.text.join('\n')
}

// v2 — but note: nodes can't enumerate widgets, so own the preview widget via
// defineWidget and react there, or use the widget's own valueChange/mount.
defineNode({
  name: 'my-org.preview',
  nodeTypes: ['MyTextNode'],
  nodeCreated(node) {
    node.on('executed', (e) => {
      // do something with e.output['text']
    })
  }
})
```

## Widgets

| v1 | v2 |
|----|----|
| `widget.value = x` | `widget.setValue(x)` (dispatches undo-able command) |
| `widget.callback = (v) => {...}` | `widget.on('valueChange', (e) => {... e.newValue ...})` |
| `widget.options.min = 0` | `widget.setOption('min', 0)` |
| `node.addWidget(type, name, default, opts)` | Declare in Python `INPUT_TYPES`; not creatable at runtime |
| `node.addDOMWidget(name, type, el, opts)` | `defineWidget({ type, mount(host, ctx) {...} })` |
| `widget.serializeValue = () => v` | `widget.on('beforeSerialize', (e) => e.setSerializedValue(v))` |
| `widget.options.serialize = false` | No equivalent — don't make it a widget (no serialize-disable in v2) |
| Read `widget.inputEl` / `widget.element` | Capture the host via closure inside `mount` — no element accessor |
| `node.computeSize` re-assignment for DOM resize | `widget.setHeight(px)` |
| `app.queuePrompt` monkey-patch for validation | `widget.on('beforeQueue', (e) => e.reject(msg))` |

```ts
// v1 DOM widget
const widget = node.addDOMWidget('myinput', 'custom', el, { ... })

// v2 — register the type, render in mount, capture el via closure
defineWidget({
  name: 'my-org.myinput',
  type: 'MY_CUSTOM',  // referenced from Python INPUT_TYPES
  mount(host, ctx) {
    const el = document.createElement('div')
    el.textContent = String(ctx.widget.getValue() ?? '')
    host.appendChild(el)
    ctx.widget.on('valueChange', (e) => { el.textContent = String(e.newValue ?? '') })
    return () => el.remove()
  }
})
```

## Events: `api.addEventListener` → typed namespaces

| v1 | v2 |
|----|----|
| `api.addEventListener('execution_start', fn)` | `execution.on('start', fn)` |
| `api.addEventListener('progress', fn)` | `execution.on('progress', fn)` |
| `api.addEventListener('executed', fn)` | per-node `node.on('executed', fn)` — the `execution` namespace carries run-level events (`execution_start`/`execution_success`/`progress`), **not** a per-node `executed` |
| `api.addEventListener('status', fn)` | `server.on('status', fn)` |
| `api.addEventListener('reconnected', fn)` | `server.on('reconnected', fn)` |
| Custom node event: `api.addEventListener('my.event', fn)` | `server.on('my.event', fn)` |
| `api.removeEventListener('x', fn)` | Call the `Unsubscribe` returned by `on(...)` |

Narrow payloads (which default to `unknown`) via module augmentation of
`ExecutionEventPayloads` / `GraphEventPayloads` / `ServerEventPayloads` /
`WorkbenchEventPayloads`. See the SKILL for the augmentation snippet.

## Shell UI

| v1 (array on the extension object) | v2 (`defineX`) |
|------------------------------------|----------------|
| `commands: [{ id, label, function }]` | `defineCommand({ id, label, function })` |
| `keybindings: [{ combo, commandId }]` | `defineHotkey({ keys: 'mod+k', commandId })` |
| `settings: [{ id, name, type, defaultValue }]` | `defineSetting({ id, name, type, defaultValue })` |
| `aboutPageBadges: [{ label, url, icon }]` | `defineAboutBadge({ label, url, icon })` |
| Action-bar buttons (undocumented) | `defineToolbarButton({ id, icon, onClick })` (net-new) |
| Sidebar tabs via `app.extensionManager.registerSidebarTab(...)` | `defineSidebarTab({ id, title, type, component })` |
| Bottom-panel tabs via the extension manager | `defineBottomPanelTab({ id, title, type, component })` |
| `app.extensionManager.toast.add(...)` | `toast.show(...)` (imperative; no handle) |

```ts
// v1
app.registerExtension({
  name: 'X',
  commands: [{ id: 'x.run', label: 'Run', function: () => doRun() }],
  keybindings: [{ combo: { key: 'k', ctrl: true }, commandId: 'x.run' }],
  aboutPageBadges: [{ label: 'GitHub', url: 'https://…', icon: 'pi-github' }]
})

// v2
defineCommand({ id: 'x.run', label: 'Run', function: () => doRun() })
defineHotkey({ keys: 'mod+k', commandId: 'x.run' })
defineAboutBadge({ label: 'GitHub', url: 'https://…', icon: 'pi-github' })
```

## Cleanup / teardown

| v1 | v2 |
|----|----|
| Manual `removeEventListener`, restore patched prototypes | `Unsubscribe` from every `on(...)`; `dispose()` from every `defineX` |
| No standard unregister for commands/tabs/settings | `handle.dispose()` (idempotent, synchronous) |
| Cleanup on node removal: patch `onRemoved` | `onNodeRemoved(fn)` inside `nodeCreated` (auto-scoped) |

## Migration checklist

1. Replace `import { app } from '../../scripts/app.js'` with named imports from `@comfyorg/extension-api`.
2. Split the single `registerExtension` object: node concerns → `defineNode`; app lifecycle → `defineExtension`; each UI concern → its own `defineX`.
3. Convert `beforeRegisterNodeDef` filtering to `defineNode({ nodeTypes: [...] })`.
4. Replace every `nodeType.prototype.onX = ...` with `node.on('x', fn)` inside `nodeCreated` / `loadedGraphNode`.
5. Replace `widget.value =` with `setValue`, `widget.callback =` with `on('valueChange')`, `widget.options.k =` with `setOption`.
6. Move DOM widgets from `addDOMWidget` to `defineWidget({ mount })`; declare the widget in Python `INPUT_TYPES`.
7. Move all serialization logic to widget-level `on('beforeSerialize')`; drop `serialize: false` usages.
8. Replace `api.addEventListener('...')` with the matching `execution` / `graph` / `server` / `workbench` namespace; augment payload interfaces for types.
9. Move validation from `app.queuePrompt` patches to `widget.on('beforeQueue', e => e.reject(...))`.
10. Ensure lifecycle hooks (`onMounted`, `onNodeMounted`, `onNodeRemoved`) are called synchronously, never after an `await`.
11. Track every `Unsubscribe` / `DisposableHandle` you create outside a `setup()` context and dispose them on teardown.
