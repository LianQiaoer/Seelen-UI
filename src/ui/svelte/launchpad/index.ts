import { getRootContainer } from "libs/ui/react/utils/index.ts";
import { mount } from "svelte";
import App from "./App.svelte";
import { Widget } from "@seelen-ui/lib";
import { lpState } from "./state.svelte.ts";

import "@seelen-ui/lib/styles/reset.css";
import "./styles/global.css";

const widget = Widget.getCurrent();
lpState.attachWidget(widget);

await widget.init({ hideOnFocusLoss: true, closeOnHide: false });
await widget.window.setFocusable(true);

widget.window.onFocusChanged(({ payload: focused }) => {
  if (!focused) lpState.noteFocusLoss();
});

let triggerChain = Promise.resolve();
widget.onTrigger(() => {
  triggerChain = triggerChain.then(() => lpState.handleTrigger()).catch(() => {});
});

mount(App, {
  target: getRootContainer(),
});

Widget.self.window.onDragDropEvent(async (e) => {
  lpState.handleDragDrop(e.payload);
});

await lpState.load();
await widget.ready({ show: false });
