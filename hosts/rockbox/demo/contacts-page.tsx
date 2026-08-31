import { Show, createMemo, createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";
import { createScroller } from "@pocketjs/framework/kinetics";
import { onButtonPress } from "@pocketjs/framework/lifecycle";
import { VirtualList } from "@pocketjs/framework/virtual-list";

const CONTACT_COUNT = 10_000;
const ROW_HEIGHT = 30;
const LIST_HEIGHT = 204;
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
    <View class="relative w-[320] h-[36] flex-row items-center justify-center bg-gradient-to-b from-[#aebbcf] via-[#7d8ea8] to-[#62738b] border-b border-[#3d4d64]">
      <Text class="text-base text-white font-bold">{props.title}</Text>
      <Show when={props.back}>
        <View class="absolute left-[5] top-[6] h-[24] px-[8] flex-row items-center rounded-[4] bg-[#71839e] border border-[#40516a]">
          <Text class="text-xs text-white font-bold">MENU: Back</Text>
        </View>
      </Show>
    </View>
  );
}

export default function ContactsPage() {
  const [detailIndex, setDetailIndex] = createSignal<number | null>(null);
  const listScroller = createScroller({
    max: () => CONTACT_COUNT * ROW_HEIGHT - LIST_HEIGHT,
    extent: () => LIST_HEIGHT,
  });
  const currentIndex = createMemo(() => Math.max(
    0,
    Math.min(CONTACT_COUNT - 1, Math.round(listScroller.offset() / ROW_HEIGHT)),
  ));
  const current = createMemo(() => contact(currentIndex()));
  const detail = createMemo(() => contact(detailIndex() ?? currentIndex()));

  onButtonPress(BTN.CIRCLE, () => {
    if (detailIndex() === null) setDetailIndex(currentIndex());
  }, { latched: true });
  onButtonPress(BTN.TRIANGLE, () => {
    if (detailIndex() !== null) setDetailIndex(null);
  }, { latched: true });

  const row = (index: number) => {
    const item = contact(index);
    const active = () => currentIndex() === index;
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
      <Show when={detailIndex() === null} fallback={
        <View class="w-[320] h-[240] flex-col bg-[#c5ccd3]">
          <NavigationBar title="Contact Info" back />
          <View class="flex-1 flex-col px-[14] pt-[14]">
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
            <Text class="text-xs text-[#596979]">Press MENU to return to the list</Text>
            <View class="h-[22]" />
          </View>
        </View>
      }>
        <NavigationBar title="All Contacts" />
        <VirtualList
          count={CONTACT_COUNT}
          rowHeight={ROW_HEIGHT}
          height={LIST_HEIGHT}
          overscan={ROW_HEIGHT * 2}
          controller={listScroller}
          focusRows={false}
          dpadStepPx={ROW_HEIGHT}
          renderRow={row}
          style={{ width: 320 }}
        />
        <View class="absolute right-[5] bottom-[5] h-[18] px-[7] flex-row items-center rounded-[9] bg-[#1e3a5fcc]">
          <Text class="text-xs text-white font-bold">
            {current().given} {current().surname} · {current().ordinal}
          </Text>
        </View>
      </Show>
    </View>
  );
}
