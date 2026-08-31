import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework";
import { Text, View } from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";
import { onButtonPress } from "@pocketjs/framework/lifecycle";

function Demo() {
  const [selection, setSelection] = createSignal(0);
  const [lastInput, setLastInput] = createSignal("READY");
  const items = ["PocketJS", "Rockbox", "iPod classic"] as const;

  onButtonPress(BTN.UP, () => {
    setSelection((value) => (value + items.length - 1) % items.length);
    setLastInput("WHEEL BACK");
  });
  onButtonPress(BTN.DOWN, () => {
    setSelection((value) => (value + 1) % items.length);
    setLastInput("WHEEL FORWARD");
  });
  onButtonPress(BTN.LEFT, () => setLastInput("LEFT"));
  onButtonPress(BTN.RIGHT, () => setLastInput("RIGHT"));
  onButtonPress(BTN.CIRCLE, () => setLastInput("SELECT"));
  onButtonPress(BTN.TRIANGLE, () => setLastInput("MENU"));
  onButtonPress(BTN.START, () => setLastInput("PLAY/PAUSE"));

  return (
    <View class="w-full h-full flex-col bg-[#10131a] p-[18]">
      <Text class="text-lg font-bold text-[#f2f5ff]">PocketJS on Rockbox</Text>
      <Text class="text-xs text-[#8fa5c8]">iPod classic 6G / 7G</Text>
      <View class="h-[14]" />
      {items.map((item, index) => (
        <View class={selection() === index
          ? "h-[38] flex-row items-center px-[12] bg-[#27a8ff]"
          : "h-[38] flex-row items-center px-[12] bg-[#1b2230]"}>
          <Text class="text-sm text-white">{item}</Text>
        </View>
      ))}
      <View class="flex-1" />
      <Text class="text-xs text-[#8fa5c8]">LAST INPUT</Text>
      <Text class="text-sm font-bold text-[#f8d45a]">{lastInput()}</Text>
      <Text class="text-xs text-[#8fa5c8]">Hold MENU to exit</Text>
    </View>
  );
}

mount(() => <Demo />);
