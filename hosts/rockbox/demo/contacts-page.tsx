import { createMemo, createSignal, onMount } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import {
  VirtualList,
  type VirtualListHandle,
} from "@pocketjs/framework/virtual-list";

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
  return {
    given,
    surname,
    ordinal: String(index + 1).padStart(5, "0"),
  };
}

export default function ContactsPage() {
  const [selected, setSelected] = createSignal(0);
  let list: VirtualListHandle | undefined;
  const selectedContact = createMemo(() => contact(selected()));

  onMount(() => list?.focusRow(0));

  const row = (index: number) => {
    const item = contact(index);
    return (
      <View class="relative w-full h-[30] flex-row items-center pl-[10] pr-[8] bg-white focus:bg-[#2378d4]">
        <Text class="text-sm text-[#1c222b] focus:text-white">{item.given}</Text>
        <Text class="ml-[4] text-sm text-[#1c222b] font-bold focus:text-white">{item.surname}</Text>
        <View class="flex-1" />
        <Text class="text-xs text-[#8b95a3] focus:text-[#dbeafe]">{item.ordinal}</Text>
        <View class="absolute left-[10] right-0 bottom-0 h-[1] bg-[#d5d8dc]" />
      </View>
    );
  };

  return (
    <View class="relative w-full h-full bg-white overflow-hidden">
      <View class="h-[36] flex-row items-center justify-center bg-gradient-to-b from-[#aebbcf] via-[#7d8ea8] to-[#62738b] border-b border-[#3d4d64]">
        <Text class="text-base text-white font-bold">All Contacts</Text>
      </View>
      <VirtualList
        count={CONTACT_COUNT}
        rowHeight={ROW_HEIGHT}
        height={LIST_HEIGHT}
        overscan={ROW_HEIGHT * 2}
        renderRow={row}
        onRowPress={setSelected}
        ref={(handle) => (list = handle)}
      />
      <View class="absolute right-[5] bottom-[5] h-[18] px-[7] flex-row items-center rounded-[9] bg-[#1e3a5fcc]">
        <Text class="text-xs text-white font-bold">
          {selectedContact().given} {selectedContact().surname} · {selectedContact().ordinal}
        </Text>
      </View>
    </View>
  );
}
