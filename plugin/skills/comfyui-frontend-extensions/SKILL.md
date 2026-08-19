---
name: comfyui-frontend-extensions
description: Authoring ComfyUI v2 frontend extensions with @comfyorg/extension-api — defineNode/defineExtension/defineWidget, shell UI (sidebar tabs, commands, hotkeys), typed events, and handles. Use when writing or editing ComfyUI web-UI extension code (custom node JS, sidebar panels, widgets).
---

# ComfyUI v2 Frontend Extension API

The **v2 extension API** is the published npm package `@comfyorg/extension-api`. It
replaces the legacy `app.registerExtension()` / `nodeType.prototype` monkey-patching
model with a typed, tree-shakeable, import-based API.

> If you are converting an existing v1 extension, read
> [`references/migrate-v1-to-v2.md`](references/migrate-v1-to-v2.md) for a
> pattern-by-pattern mapping.

## Mental model

| v1 (legacy) | v2 (`@comfyorg/extension-api`) |
|-------------|-------------------------------|
| One giant `app.registerExtension({...})` call | One `defineX` per concern, each independently disposable |
| `window.app` / `app.*` globals | Direct `import` from the package; no `window.app` at module-eval time |
| `nodeType.prototype.onExecuted = ...` patching | `node.on('executed', fn)` on a `NodeHandle` |
| Mutate `widget.value`, assign `widget.callback` | `widget.setValue(v)` / `widget.on('valueChange', fn)` |
| `api.addEventListener('execution_start', fn)` | `execution.on('start', fn)` (typed namespaces) |
| Manual `removeEventListener` bookkeeping | Every subscription returns `Unsubscribe`; every `defineX` returns `DisposableHandle` |

Core principles baked into the API:

- **Import, don't reach for globals.** `import { defineNode } from '@comfyorg/extension-api'`. No `window.app` dependency at module evaluation time.
- **Read via getters, write via command-dispatch setters.** `getValue()` reads; `setValue()` dispatches an undo-able, serializable command. Read-only invariants (set at construction) are `readonly` accessors (`node.type`, `widget.name`).
- **Observe via typed `on(...)` subscriptions.** Each returns an `Unsubscribe` cleanup function. No Vue refs/signals are ever exposed — Vue reactivity is the internal engine only.
- **Everything is disposable.** Every `defineX` returns a `DisposableHandle` with an idempotent, synchronous `dispose()`.

## Registration entry points

All imported from `@comfyorg/extension-api`:

| Function | Purpose | Returns |
|----------|---------|---------|
| `defineNode(opts)` | **Primary entry** — react to node lifecycle (replaces prototype patching) | `NodeExtensionOptions` |
| `defineExtension(opts)` | App-scoped lifecycle (`init`/`setup`) + shell UI host | `ExtensionOptions` |
| `defineWidget(opts)` | Register a custom widget type (DOM via `mount`) | `WidgetExtensionOptions` |
| `defineSidebarTab(opts)` | Add a left-sidebar tab (Vue or custom) | `DisposableHandle` |
| `defineBottomPanelTab(opts)` | Add a bottom-panel tab | `DisposableHandle` |
| `defineToolbarButton(opts)` | Add an action-bar button | `DisposableHandle` |
| `defineCommand(opts)` | Register an invokable command | `DisposableHandle` |
| `defineHotkey(opts)` | Bind a key combo to a command id | `DisposableHandle` |
| `defineSetting(opts)` | Add a settings-menu entry | `DisposableHandle` |
| `defineAboutBadge(opts)` | Add a badge to the About page | `DisposableHandle` |

Imperative carve-outs (fire-and-forget, NOT `defineX`, no handle): `toast`, `notify`.

A single extension file typically exports a **default** `defineExtension`/`defineNode`
result and calls the shell-UI `defineX` functions inside `setup()` (or at module scope —
they queue safely before the app boots).

## `defineNode` — the primary entry point

Reacts to node lifecycle. `nodeCreated` fires once per node instance (typed in, pasted,
duplicated, or loaded without an existing workflow). `loadedGraphNode` fires once when a
node is restored from a saved workflow (widget values already populated). Exactly one of
them fires per node entity — never both.

```ts
import { defineNode, onNodeMounted, onNodeRemoved } from '@comfyorg/extension-api'

export default defineNode({
  name: 'my-org.executed-logger',
  // Filter to specific comfyClass names. Omit to receive every node type.
  nodeTypes: ['KSampler', 'KSamplerAdvanced'],

  // MUST be synchronous. Runs inside a Vue EffectScope; everything registered
  // here (subscriptions, onNodeMounted) auto-disposes when the node is removed.
  nodeCreated(node) {
    // Read-only invariants
    console.log(node.type, node.comfyClass, node.id)

    // Subscribe to backend execution completion (replaces onExecuted patching)
    node.on('executed', (e) => {
      console.log('output:', e.output) // Record<string, unknown>
    })

    // Lifecycle hooks — call SYNCHRONOUSLY (never after an await)
    onNodeMounted(() => {
      // Node fully mounted; DOM/canvas ready.
    })
    onNodeRemoved(() => {
      // Cleanup: abort fetches, close sockets. Does NOT fire on subgraph promotion.
    })
  },

  loadedGraphNode(node) {
    // Node restored from a saved workflow; widget values are already set.
  }
})
```

### `NodeHandle` surface (Phase A)

| Member | Kind | Notes |
|--------|------|-------|
| `id: string` | readonly | Opaque token. Compare with `node.equals(other)`, never by slicing. |
| `equals(other)` | method | Canonical identity comparison. |
| `type: string` | readonly | LiteGraph node type. |
| `comfyClass: string` | readonly | Backend class name. |
| `getProperty<T>(key)` / `getProperties()` / `setProperty(key, v)` | methods | Per-instance props (migration shim — prefer widget values). |
| `getInputs()` / `getOutputs()` | methods | `ReadonlyArray<Readonly<SlotInfo>>` — frozen views. |
| `on('executed', fn)` | method | Execution complete → `NodeExecutedEvent { output }`. |
| `on('removed', fn)` | method | Node deleted (not subgraph promotion). |
| `on('configured', fn)` | method | Loaded from saved workflow (after widget values restored). |
| `on('beforeSerialize', fn)` | method | **Deprecated** — use widget-level `beforeSerialize` (ADR-0010). |

> Position/size/title/mode getters and slot/connection events are **deferred in Phase A**. Do not rely on `getPosition`, `setSize`, `getMode`, `on('connected')`.
>
> Nodes **cannot enumerate or reference their widgets** (`node.getWidget(name)` was removed). Use `defineWidget` and the `mount` context's `ctx.widget` handle.

## `defineExtension` — app lifecycle + shell UI

Use for app-wide setup and to host shell-UI registrations. `setup()` runs at the
early registration point; use the imported `onMounted` hook for work that needs the
app fully initialized.

```ts
import {
  defineExtension,
  onMounted,
  onUnmounted,
  execution,
  toast
} from '@comfyorg/extension-api'

export default defineExtension({
  name: 'my-org.my-extension',
  setup() {
    // Register late-lifecycle work via onMounted (called synchronously here).
    onMounted(() => {
      const off = execution.on('start', () => {
        toast.show({ severity: 'info', summary: 'Run started' })
      })
      onUnmounted(off) // tidy teardown
    })
  }
})
```

> **`setup()` signature note.** The source-of-truth surface uses *implicit-context*
> hooks: import `onMounted`/`onNodeMounted`/etc. and call them synchronously inside
> `setup()` (mirrors Vue's Composition API). An early package draft showed a
> `setup(ctx) { ctx.onNodeMounted(...) }` context-argument style; prefer the imported-hook
> form above, which is what the current API exports.

Context-scoped lifecycle hooks are imported and called **synchronously inside
`defineExtension`'s `setup()`**: `onBeforeMount`, `onMounted`, `onUnmounted`,
`onActivated`, `onDeactivated`. Note: `defineSidebarTab`/`defineBottomPanelTab` take **no
`setup` field** — don't add one (it's a type error). `onActivated`/`onDeactivated` fire
when the surrounding tab/panel is shown/hidden.

## `defineWidget` — custom widget types with DOM

Widgets are **declared in the Python node's `INPUT_TYPES`**, never created at runtime
(`node.addWidget` is forbidden). `defineWidget` registers a *type* and the DOM `mount`
hook the runtime invokes against a host `<div>` it owns. `mount` is optional — omit it
for value-only widgets that render through the native renderer.

```ts
import { defineWidget, type WidgetCleanup } from '@comfyorg/extension-api'

export default defineWidget({
  name: 'my-org.color-picker',
  type: 'COLOR_PICKER', // referenced from Python INPUT_TYPES

  // The SOLE DOM seam. Capture host + constructed DOM via closure — there is
  // no widget.element accessor.
  mount(host, ctx): WidgetCleanup {
    const input = document.createElement('input')
    input.type = 'color'
    input.value = String(ctx.widget.getValue() ?? '#000000')
    input.addEventListener('input', () => ctx.widget.setValue(input.value))
    host.appendChild(input)

    // ctx.widget / ctx.node are the only legal handles here.
    ctx.widget.on('valueChange', (e) => {
      input.value = String(e.newValue ?? '#000000')
    })

    // Optional cleanup — fires once on widget destruction (NOT on host remount).
    return () => input.remove()
  }
})
```

`WidgetMountContext` also exposes `onUnmount(fn)`, `onBeforeRemount(fn)`, and
`onAfterRemount(fn => ...)` for host-move scenarios (graph↔app mode, subgraph
promotion). The `mount` body is **not** re-invoked across a remount — only the
remount hooks fire.

### `WidgetHandle` surface

| Member | Kind | Notes |
|--------|------|-------|
| `id` / `equals(other)` | readonly / method | Opaque identity. |
| `name` / `widgetType` / `label` | readonly | Set from `INPUT_TYPES` schema. |
| `getValue<T>()` / `setValue(v)` | methods | `setValue` dispatches an undo-able command. |
| `options` | readonly | `Readonly<WidgetOptions>` snapshot. Writes raise TS errors. |
| `getOption<K>(key)` / `setOption(key, v)` | methods | Per-instance overrides (e.g. `min`/`max`/`step`). |
| `setHeight(px)` | method | Resize the reserved host height (DOM widgets). |
| `on('valueChange', fn)` | method | `WidgetValueChangeEvent { oldValue, newValue }`. |
| `on('optionChange', fn)` | method | `WidgetOptionChangeEvent { key, oldValue, newValue }`. |
| `on('beforeSerialize', fn)` | method | **Only async-allowed event.** `e.value` + `e.setSerializedValue(v)`. |
| `on('beforeQueue', fn)` | method | Pre-queue validation. Call `e.reject(msg)` to cancel. |

```ts
// Serialization override (the SOLE serialization interface in v2):
widget.on('beforeSerialize', (e) => {
  e.setSerializedValue(processDynamicPrompt(widget.getValue()))
})

// Async serialization (e.g. capture a webcam frame before queueing):
widget.on('beforeSerialize', async (e) => {
  e.setSerializedValue(await captureFrame())
})

// Pre-queue validation (replaces app.queuePrompt monkey-patching):
widget.on('beforeQueue', (e) => {
  if (!widget.getValue()) e.reject('Prompt text is required before queueing.')
})
```

## Typed event namespaces

Four module-level singletons replace `api.addEventListener('...')`. Each `on()`
returns an `Unsubscribe`. Subscriptions made inside a `setup()` body auto-dispose
on unmount; subscriptions made elsewhere are the caller's responsibility.

| Namespace | Events (canonical) | Wire mapping |
|-----------|--------------------|--------------|
| `execution` | `start`, `end`, `error`, `interrupted`, `cached`, `executing`, `progress`, `preview` | `execution_<evt>` |
| `graph` | `changed`, … | `graph:<evt>` |
| `server` | `status`, `logs`, `reconnected`, `feature_flags`, `assets`, **+ custom-node events** | raw event name |
| `workbench` | `notification`, … | `workbench:<evt>` |

```ts
import { execution, server } from '@comfyorg/extension-api'

const off = execution.on('progress', (e) => console.log('progress', e))
// Custom-node events ride the `server` namespace with arbitrary names:
server.on('my-org.my-node.update', (e) => console.log(e))
// later:
off()
```

Payloads default to `unknown` today. Narrow them with **TS module augmentation**:

```ts
declare module '@comfyorg/extension-api' {
  interface ExecutionEventPayloads {
    start: { promptId: string }
    progress: { value: number; max: number }
  }
  interface ServerEventPayloads {
    'my-org.my-node.update': { nodeId: string; text: string }
  }
}
```

The augmentable interfaces are `GraphEventPayloads`, `ExecutionEventPayloads`,
`ServerEventPayloads`, and `WorkbenchEventPayloads`.

## Shell UI registrations

Each returns a `DisposableHandle`. Safe to call at module scope (they queue until the
app boots) or inside `setup()`.

```ts
import {
  defineCommand,
  defineHotkey,
  defineToolbarButton,
  defineSetting,
  defineAboutBadge
} from '@comfyorg/extension-api'

// Command — id, function, optional label/icon/tooltip.
const cmd = defineCommand({
  id: 'my-org.do-the-thing',
  label: 'Do The Thing',
  function: () => { /* ... */ }
})

// Hotkey — binds a key combo to an already-registered command id.
// `mod` = cmd on macOS, ctrl elsewhere.
defineHotkey({ keys: 'mod+shift+k', commandId: 'my-org.do-the-thing' })

// Action-bar button — id (for dispose), icon, onClick.
defineToolbarButton({
  id: 'my-org.help',
  icon: 'pi-question-circle',
  tooltip: 'Get help',
  onClick: () => openHelp()
})

// Setting — widen the id when not augmenting the Settings keymap.
defineSetting({
  id: 'my-org.enabled' as never,
  name: 'Enable my extension',
  type: 'boolean',
  defaultValue: false
})

// About-page badge.
defineAboutBadge({
  label: 'GitHub',
  url: 'https://github.com/me/my-ext',
  icon: 'pi-github'
})

// Tear down any registration:
cmd.dispose() // idempotent + synchronous
```

`CommandDefinition` fields: `id` (required), `function: (metadata?) => void | Promise<void>` (required), optional `label` / `icon` / `tooltip` (each `string | (() => string)`), `menubarLabel`, `versionAdded`.

## `defineSidebarTab` — embedded panels (e.g. a chat panel)

A sidebar tab is the substrate for a rich embedded UI such as a chat panel. Two flavors:
`type: 'vue'` (mount a Vue component) or `type: 'custom'` (imperative `render(container)` /
`destroy()`). Both share the base fields `id`, `title`, optional `icon`, `iconBadge`,
`tooltip`, `label`.

### Vue component tab

```ts
import { defineSidebarTab } from '@comfyorg/extension-api'
import ChatPanel from './ChatPanel.vue'

const chatTab = defineSidebarTab({
  id: 'my-org.chat',
  title: 'Chat',
  type: 'vue',
  icon: 'pi-comments',
  component: ChatPanel
})
// chatTab.dispose() removes the tab.
```

### Custom (framework-free) chat panel

When you don't want a Vue dependency, use `type: 'custom'` and build the DOM yourself.
`render` receives the container; `destroy` is your teardown.

```ts
import {
  defineExtension,
  defineSidebarTab,
  execution,
  server,
  type Unsubscribe
} from '@comfyorg/extension-api'

export default defineExtension({
  name: 'my-org.chat-panel',
  setup() {
    const subscriptions: Unsubscribe[] = []

    defineSidebarTab({
      id: 'my-org.chat',
      title: 'Chat',
      type: 'custom',
      icon: 'pi-comments',

      render(container: HTMLElement) {
        const log = document.createElement('div')
        log.className = 'chat-log'

        const form = document.createElement('form')
        const input = document.createElement('input')
        input.placeholder = 'Ask something…'
        const send = document.createElement('button')
        send.type = 'submit'
        send.textContent = 'Send'
        form.append(input, send)

        const append = (who: string, text: string) => {
          const line = document.createElement('p')
          line.textContent = `${who}: ${text}`
          log.appendChild(line)
          log.scrollTop = log.scrollHeight
        }

        form.addEventListener('submit', (ev) => {
          ev.preventDefault()
          const text = input.value.trim()
          if (!text) return
          append('You', text)
          input.value = ''
          // Forward to a backend node/server event, stream the reply, etc.
        })

        container.append(log, form)

        // Stream backend replies via the server namespace (custom-node event).
        subscriptions.push(
          server.on('my-org.chat.reply', (e) => append('Assistant', String(e)))
        )
        // React to runs to show status in the panel.
        subscriptions.push(
          execution.on('start', () => append('System', 'Run started…'))
        )
      },

      destroy() {
        for (const off of subscriptions) off()
        subscriptions.length = 0
      }
    })
  }
})
```

`defineBottomPanelTab` has the same `vue` / `custom` shapes (base fields `id`, optional
`title`/`titleKey`, optional `targetPanel: 'terminal' | 'shortcuts'`).

## Toasts

`toast` and `notify` are inline imperative (no `defineX`, no handle). Call from any
`setup()` body or hook closure.

```ts
import { toast } from '@comfyorg/extension-api'

toast.show({ severity: 'error', summary: 'Workflow failed', detail: err.message, life: 4000 })
toast.removeAll()
```

`notify({ kind, message, detail, life })` is a deprecated 1:1 wrapper over `toast.show` —
prefer `toast.show` directly.

## Node identity helpers

For referencing nodes across subgraph boundaries or execution runs, use the branded
identity primitives rather than raw integer node IDs:

```ts
import {
  createNodeLocatorId, parseNodeLocatorId, isNodeLocatorId,
  createNodeExecutionId, parseNodeExecutionId, isNodeExecutionId,
  type NodeLocatorId, type NodeExecutionId
} from '@comfyorg/extension-api'

const locator: NodeLocatorId = createNodeLocatorId(subgraphUuid, localNodeId)
// NodeExecutionId encodes a node's path through nested subgraphs as an array of node ids
// (joined with ':'). Pass the array, not positional args:
const execId: NodeExecutionId = createNodeExecutionId([localNodeId])

if (isNodeLocatorId(maybe)) {
  // parseNodeLocatorId returns { subgraphUuid: string | null; localNodeId: NodeId }
  const { subgraphUuid, localNodeId } = parseNodeLocatorId(maybe)
}
```

`NodeLocatorId` arrives from workflow JSON; `NodeExecutionId` arrives from websocket
frames. You **receive** these from event payloads — that's why they're public (unlike the
internal `*EntityId` brands, which are not exported).

## Disposal contract

Every `defineX` returns `DisposableHandle { dispose(): void }`:

- **Idempotent** — calling `dispose()` again is a safe no-op.
- **Synchronous** — teardown happens synchronously inside `dispose()`.
- **Independent** — disposing handle A does not affect B or C. Sequence calls
  explicitly when teardown order matters (e.g. drop a hotkey before its command).
- **Pre-mount safe** — disposing before the app boots removes the spec from the
  pending queue so it never mounts.

```ts
const handles = [
  defineCommand({ id: 'my.cmd', function: () => {} }),
  defineHotkey({ keys: 'mod+k', commandId: 'my.cmd' }),
  defineSidebarTab({ id: 'my.tab', title: 'Tab', type: 'vue', component: MyTab })
]
// Full teardown:
for (const h of handles.reverse()) h.dispose()
```

## Common mistakes

1. **Calling lifecycle hooks after `await`.** `onNodeMounted` / `onMounted` / `onUnmounted` rely on implicit scope context and **must** be called synchronously inside the `setup()`/`nodeCreated` body. After an `await` the scope is gone — throws in dev, silent no-op in prod. Kick off async work in the body, but register hooks first.
2. **Reaching for `window.app` or `app.*`.** v2 has no `window.app` dependency at module-eval time. Import everything from `@comfyorg/extension-api`.
3. **Patching `nodeType.prototype`.** Replaced by `defineNode` + `node.on(...)`. Prototype patching does not interoperate with the v2 handle model.
4. **Mutating reads.** `node.getInputs()`, `widget.options`, and `Point`/`Size` tuples are frozen/`Readonly` — assignment raises TS errors. Use the setter methods (`widget.setOption`, `widget.setValue`).
5. **Assigning `widget.value` / `widget.callback` / `widget.serializeValue`.** Use `setValue()`, `on('valueChange')`, and `on('beforeSerialize')`. `serializeValue` is read-only on the v2 surface.
6. **Trying to disable widget serialization.** There is no `serialize: false` and no `skip()` in v2. If a widget should not contribute to the payload, it should not be a widget. The only serialization interface is `widget.on('beforeSerialize', fn)` + `e.setSerializedValue(v)`.
7. **Creating widgets at runtime.** `node.addWidget(...)` / `node.addDOMWidget(...)` are removed. Declare widgets in the Python `INPUT_TYPES`; render custom DOM via `defineWidget({ mount })`.
8. **Enumerating widgets from a node.** `node.getWidget(name)` / `node.getWidgets()` were removed (nodes cannot reference widgets). Use a `defineWidget` mount context's `ctx.widget`, or share state via the `server` event bus.
9. **Using node-level `beforeSerialize`.** Deprecated (ADR-0010). Store extension state in a widget and use widget-level `beforeSerialize`.
10. **Forgetting to dispose.** Long-lived subscriptions made outside a `setup()` context, and every `defineX` handle, leak unless you call the returned `Unsubscribe` / `dispose()`. Inside `setup()` they auto-dispose on unmount.
11. **Relying on deferred Phase A surface.** Position/size/title/mode getters and slot/connection events are not yet exported. Don't write code against them.

## Sources

- **Official:** npm package `@comfyorg/extension-api` at https://www.npmjs.com/package/@comfyorg/extension-api
- **Empirical:** none — API surface transcribed from the published package, not reverse-engineered from a working graph.
