import { Show, createMemo, createSignal } from "solid-js";
import { animate } from "@pocketjs/framework/animation";
import {
  Text,
  View,
  type NodeMirror,
} from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";
import { createScroller } from "@pocketjs/framework/kinetics";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { VirtualList } from "@pocketjs/framework/virtual-list";
import {
  CONTACT_LIST_HEIGHT,
  CONTACT_MAX_OFFSCREEN_PX,
  CONTACT_ROW_HEIGHT,
  CONTACT_SPRING_DAMPING,
  CONTACT_SPRING_OVERSHOOT,
  CONTACT_SPRING_STIFFNESS,
  boundedVisualContactIndex,
  contactScrollTarget,
  wheelMultiplier,
} from "./contact-motion.ts";

const CONTACT_COUNT = 10_000;
const WHEEL_ACCEL_RESET_FRAMES = 6;
const SURNAMES = [
  "Adams", "Bennett", "Carter", "Dawson", "Ellis", "Foster", "Garcia",
  "Hayes", "Irwin", "Jordan", "Keller", "Lewis", "Morris", "Nelson",
  "Owens", "Parker", "Quinn", "Reed", "Sullivan", "Turner", "Underwood",
  "Vaughn", "Walker", "Xavier", "Young", "Zimmerman",
] as const;
const GIVEN_NAMES = [
  "Avery", "Chloe", "Elliot", "Harper", "Jamie", "Morgan", "Riley", "Taylor",
] as const;

function contact(index: number) {
  const surname = SURNAMES[Math.floor(index * SURNAMES.length / CONTACT_COUNT)];
  const given = GIVEN_NAMES[(index * 5 + surname.length) % GIVEN_NAMES.length];
  const line = String((index * 17 + 31) % 100).padStart(2, "0");
  return {
    given,
    surname,
    ordinal: String(index + 1).padStart(5, "0"),
    phone: `(415) 555-01${line}`,
    email: `${given}@${surname}.com`.toLowerCase(),
  };
}

function NavigationBar(props: { title: string; back?: boolean }) {
  return (
    <View class="absolute left-0 top-0 w-[320] h-[36] flex-row items-center justify-center bg-gradient-to-b from-[#aebbcf] via-[#7d8ea8] to-[#62738b]">
      <Show when={!props.back}>
        <Text class="text-base text-white font-bold">{props.title}</Text>
      </Show>
      <Show when={props.back}>
        <View class="absolute left-[5] top-[6] h-[24] px-[8] flex-row items-center rounded-[4] bg-[#71839e] border border-[#40516a]">
          <Text class="text-xs text-white font-bold">MENU: Back</Text>
        </View>
      </Show>
      <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#3d4d64]" />
    </View>
  );
}

function SelectionFollower(props: { update: () => void }) {
  onFrame(() => props.update());
  return null;
}

export default function ContactsPage() {
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [destinationIndex, setDestinationIndex] = createSignal(0);
  const [detailIndex, setDetailIndex] = createSignal(0);
  const [detailOpen, setDetailOpen] = createSignal(false);
  let listPanel: NodeMirror | undefined;
  let detailPanel: NodeMirror | undefined;
  let wheelDirection = 0;
  let wheelBurst = 0;
  let wheelIdleFrames = WHEEL_ACCEL_RESET_FRAMES;
  const listScroller = createScroller({
    max: () => CONTACT_COUNT * CONTACT_ROW_HEIGHT - CONTACT_LIST_HEIGHT,
    extent: () => CONTACT_LIST_HEIGHT,
  });
  const detail = createMemo(() => contact(detailIndex()));

  const resetWheelAcceleration = () => {
    wheelDirection = 0;
    wheelBurst = 0;
    wheelIdleFrames = WHEEL_ACCEL_RESET_FRAMES;
  };

  const moveSelection = (delta: number) => {
    const next = Math.max(0, Math.min(CONTACT_COUNT - 1, destinationIndex() + delta));
    if (next === destinationIndex()) return;
    setDestinationIndex(next);
    const maxOffset = CONTACT_COUNT * CONTACT_ROW_HEIGHT - CONTACT_LIST_HEIGHT;
    const target = contactScrollTarget(next, listScroller.intent(), maxOffset);
    if (target !== null) {
      listScroller.springTo(target, {
        overshootPx: CONTACT_SPRING_OVERSHOOT,
        stiffness: CONTACT_SPRING_STIFFNESS,
        damping: CONTACT_SPRING_DAMPING,
      });
    }
  };

  const updateVisualSelection = () => {
    setSelectedIndex(boundedVisualContactIndex(
      destinationIndex(),
      listScroller.offset(),
      CONTACT_COUNT,
    ));
  };

  const acceleratedWheelDelta = (direction: -1 | 1) => {
    if (wheelDirection !== direction || wheelIdleFrames >= WHEEL_ACCEL_RESET_FRAMES) {
      wheelDirection = direction;
      wheelBurst = 0;
    } else {
      wheelBurst += 1;
    }
    wheelIdleFrames = 0;
    return direction * wheelMultiplier(wheelBurst);
  };

  onFrame((buttons) => {
    if (detailOpen()) return;
    if ((buttons & BTN.UP) !== 0) {
      moveSelection(acceleratedWheelDelta(-1));
    } else if ((buttons & BTN.DOWN) !== 0) {
      moveSelection(acceleratedWheelDelta(1));
    } else {
      wheelIdleFrames = Math.min(WHEEL_ACCEL_RESET_FRAMES, wheelIdleFrames + 1);
    }
  });

  onButtonPress(BTN.CIRCLE, () => {
    if (detailOpen()) return;
    resetWheelAcceleration();
    setDetailIndex(destinationIndex());
    setDetailOpen(true);
    if (listPanel) animate(listPanel, "translateX", -64, { dur: 110, easing: "out" });
    if (detailPanel) animate(detailPanel, "translateX", 0, { dur: 110, easing: "out" });
  }, { latched: true });
  onButtonPress(BTN.TRIANGLE, () => {
    if (!detailOpen()) return;
    resetWheelAcceleration();
    setDetailOpen(false);
    if (listPanel) animate(listPanel, "translateX", 0, { dur: 110, easing: "out" });
    if (detailPanel) animate(detailPanel, "translateX", 320, { dur: 110, easing: "out" });
  }, { latched: true });

  const row = (index: number) => {
    const item = contact(index);
    const active = () => selectedIndex() === index;
    return (
      <View class={active()
        ? "relative w-[320] h-[30] flex-row items-center pl-[10] pr-[8] bg-[#2378d4]"
        : "relative w-[320] h-[30] flex-row items-center pl-[10] pr-[8] bg-white"}>
        <Text class={active() ? "text-sm text-white" : "text-sm text-[#1c222b]"}>{item.given}</Text>
        <Text class={active()
          ? "ml-[4] text-sm text-white font-bold"
          : "ml-[4] text-sm text-[#1c222b] font-bold"}>
          {item.surname}
        </Text>
        <View class="flex-1" />
        <Text class={active()
          ? "text-xs text-[#dbeafe]"
          : "text-xs text-[#8b95a3]"}>
          {item.ordinal}
        </Text>
        <View class={active()
          ? "absolute left-[10] right-0 bottom-0 h-[1] bg-[#155da8]"
          : "absolute left-[10] right-0 bottom-0 h-[1] bg-[#d5d8dc]"} />
      </View>
    );
  };

  return (
    <View class="relative w-[320] h-[240] bg-white overflow-hidden">
      <View
        ref={(node) => (listPanel = node)}
        class="absolute left-0 top-0 w-[320] h-[240] bg-white overflow-hidden"
      >
        <View class="absolute left-0 top-[36] w-[320] h-[204] bg-white overflow-hidden">
          <VirtualList
            count={CONTACT_COUNT}
            rowHeight={CONTACT_ROW_HEIGHT}
            height={CONTACT_LIST_HEIGHT}
            overscan={CONTACT_MAX_OFFSCREEN_PX + CONTACT_ROW_HEIGHT}
            controller={listScroller}
            focusRows={false}
            inputActive={() => false}
            renderRow={row}
            style={{ width: 320 }}
          />
        </View>
        <SelectionFollower update={updateVisualSelection} />
        <NavigationBar title="All Contacts" />
      </View>

      <View
        ref={(node) => (detailPanel = node)}
        class="absolute left-0 top-0 w-[320] h-[240] bg-[#c5ccd3] overflow-hidden"
        style={{ translateX: 320 }}
      >
        <View class="absolute left-0 top-[36] w-[320] h-[204] flex-col px-[14] pt-[14] bg-[#c5ccd3] overflow-hidden">
          <View class="h-[56] flex-col justify-center px-[12] rounded-[8] bg-white border border-[#a4abb3]">
            <Text class="text-lg text-[#15181c] font-bold">{detail().given} {detail().surname}</Text>
            <Text class="text-xs text-[#6a727b]">Contact {detail().ordinal} of 10,000</Text>
          </View>
          <View class="h-[10]" />
          <View class="h-[72] flex-col rounded-[8] bg-white border border-[#a4abb3] overflow-hidden">
            <View class="h-[35] flex-row items-center px-[10]">
              <Text class="w-[55] text-xs text-[#55677d] font-bold">mobile</Text>
              <Text class="text-sm text-[#15181c]">{detail().phone}</Text>
            </View>
            <View class="h-[1] bg-[#c9ced4]" />
            <View class="h-[35] flex-row items-center px-[10]">
              <Text class="w-[55] text-xs text-[#55677d] font-bold">email</Text>
              <Text class="text-sm text-[#1b4fa8]">{detail().email}</Text>
            </View>
          </View>
          <View class="flex-1" />
        </View>
        <NavigationBar title="Contact Info" back />
      </View>
    </View>
  );
}
