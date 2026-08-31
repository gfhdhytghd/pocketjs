import { Show, createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Text, View } from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";
import { onButtonPress } from "@pocketjs/framework/lifecycle";
import ContactsPage from "./contacts-page.tsx";
import InputTestPage from "./input-test-page.tsx";
import StandardPage from "./standard-page.tsx";

const PAGE_COUNT = 3;
const PAGE_LABELS = ["DEMO", "INPUT", "CONTACTS"] as const;

function RockboxDemo() {
  const [page, setPage] = createSignal(0);

  onButtonPress(BTN.LEFT | BTN.RIGHT, (pressed, buttons) => {
    if ((buttons & BTN.CIRCLE) === 0) return;
    if ((pressed & BTN.LEFT) !== 0) {
      setPage((value) => (value + PAGE_COUNT - 1) % PAGE_COUNT);
    } else if ((pressed & BTN.RIGHT) !== 0) {
      setPage((value) => (value + 1) % PAGE_COUNT);
    }
  });

  return (
    <View class="relative w-full h-full bg-[#10131a] overflow-hidden">
      <Show when={page() === 0}>
        <StandardPage />
      </Show>
      <Show when={page() === 1}>
        <InputTestPage />
      </Show>
      <Show when={page() === 2}>
        <ContactsPage />
      </Show>

      <View class="absolute right-[6] top-[5] h-[18] px-[7] flex-row items-center rounded-[9] bg-[#111827cc]">
        <Text class="text-xs text-white font-bold">
          {page() + 1}/{PAGE_COUNT} {PAGE_LABELS[page()]}
        </Text>
      </View>
      <View class="absolute left-[6] bottom-[5] h-[16] px-[6] flex-row items-center rounded-[8] bg-[#111827cc]">
        <Text class="text-xs text-[#dbeafe]">SELECT + LEFT / RIGHT</Text>
      </View>
    </View>
  );
}

mount(() => <RockboxDemo />);
