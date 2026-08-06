import { useLayoutEffect, useRef, useState } from "octane";
import { Text, View, type NodeMirror } from "@pocketjs/framework/octane/components";
import { animate } from "@pocketjs/framework/octane/animation";
import { useFrame } from "@pocketjs/framework/octane/lifecycle";

interface Notice {
  id: string;
  title: string;
  message: string;
  time: string;
  dotCls: string;
}

const INITIAL: Notice[] = [
  { id: "update", title: "UPDATE AVAILABLE", message: "Firmware 6.61 is ready to install.", time: "2m ago", dotCls: "w-2 h-2 rounded-full bg-sky-500" },
  { id: "friend", title: "FRIEND REQUEST", message: "RIDGE_FOX wants to join your session.", time: "14m ago", dotCls: "w-2 h-2 rounded-full bg-emerald-500" },
  { id: "battery", title: "LOW BATTERY", message: "12% remaining - plug in soon.", time: "35m ago", dotCls: "w-2 h-2 rounded-full bg-amber-500" },
  { id: "trophy", title: "TROPHY UNLOCKED", message: '"First Contact" - Iron Vanguard.', time: "1h ago", dotCls: "w-2 h-2 rounded-full bg-blue-500" },
];

const DISMISS_FRAMES = 16;
const ROW_RISE_PX = 42;
const ROW_RISE_FRAMES = 16;

interface NoticeRowProps {
  key?: string;
  item: Notice;
  index: number;
  rise: number;
  onRowRef: (id: string, row: NodeMirror) => void;
  onDismiss: (id: string, el: NodeMirror | undefined) => void;
}

function NoticeRow(props: NoticeRowProps) {
  const el = useRef<NodeMirror | null>(null);

  useLayoutEffect(() => {
    const card = el.current;
    if (card) {
      animate(card, "opacity", 1, { dur: 250, delay: props.index * 70, easing: "out" });
      animate(card, "translateX", 0, { dur: 250, delay: props.index * 70, easing: "out" });
    }
  }, []);

  return (
    <View
      nodeRef={(row: NodeMirror | null) => {
        if (row) props.onRowRef(props.item.id, row);
      }}
      class="flex-col"
      style={{ translateY: props.rise }}
    >
      <View
        nodeRef={el}
        style={{ opacity: 0, translateX: 16 }}
        class="flex-row items-center gap-3 p-1 rounded-lg shadow bg-white border-slate-200 focus:bg-blue-50 focus:border-blue-500 transition-colors duration-150"
        focusable
        onPress={() => props.onDismiss(props.item.id, el.current ?? undefined)}
      >
        <View class={props.item.dotCls} />
        <View class="flex-col grow">
          <Text class="text-xs text-slate-950 font-bold">{props.item.title}</Text>
          <Text class="text-xs text-slate-600">{props.item.message}</Text>
        </View>
        <Text class="text-xs text-slate-500">{props.item.time}</Text>
      </View>
    </View>
  );
}

export default function Notifications() {
  const [items, setItems] = useState<Notice[]>([...INITIAL]);
  const rowRefs = useRef(new Map<string, NodeMirror>());
  // The dismissal state machine lives in refs: which row is leaving, which
  // rows are sliding up, how many frames are left. In state, each phase edge
  // replays the whole root — three replays of ~35 component bodies per
  // dismissal, ~200 ms each on the PSP — and only one of the three changes
  // anything, because only `items` reaches the render tree. `risingIds` is
  // read during that one replay to seed the survivors' offset, so it must be
  // assigned before setItems.
  const dismissingId = useRef<string | null>(null);
  const risingIds = useRef<string[]>([]);
  const riseFramesLeft = useRef(0);
  const dismissTick = useRef(0);

  const busy = () =>
    dismissingId.current !== null || risingIds.current.length > 0 || riseFramesLeft.current > 0;

  useFrame(() => {
    if (risingIds.current.length > 0) {
      for (const id of risingIds.current) {
        const row = rowRefs.current.get(id);
        if (row) animate(row, "translateY", 0, { dur: 180, easing: "out" });
      }
      risingIds.current = [];
      riseFramesLeft.current = ROW_RISE_FRAMES;
    } else if (riseFramesLeft.current > 0) {
      riseFramesLeft.current -= 1;
    }

    const id = dismissingId.current;
    if (id === null) return;
    dismissTick.current += 1;
    if (dismissTick.current < DISMISS_FRAMES) return;

    const before = items;
    const removedIndex = before.findIndex((it) => it.id === id);
    const rising = removedIndex < 0 ? [] : before.slice(removedIndex + 1).map((it) => it.id);
    // Set before setItems, because the replay it triggers rebuilds the rows
    // and reads this to seed their offset. A jump() here would be lost: the
    // survivors are recreated by that replay, so the node it wrote to is gone
    // by the time the tween starts.
    risingIds.current = rising;
    rowRefs.current.delete(id);
    setItems(before.filter((it) => it.id !== id));
    dismissingId.current = null;
    dismissTick.current = 0;
  });

  const dismiss = (id: string, el: NodeMirror | undefined) => {
    if (busy() || !el) return;
    dismissingId.current = id;
    dismissTick.current = 0;
    animate(el, "opacity", 0, { dur: 200, easing: "out" });
    animate(el, "translateX", 24, { dur: 200, easing: "out" });
  };

  return (
    <View class="flex-col w-full h-full p-3 gap-2 bg-gradient-to-b from-slate-50 to-slate-100">
      <View class="flex-row items-end justify-between">
        <View class="flex-col">
          <Text class="text-xs text-blue-600 tracking-wide">POCKETJS SHOWCASE</Text>
          <Text class="text-2xl text-slate-950 font-bold">Notifications</Text>
        </View>
        <Text class="text-xs text-slate-500">{`${items.length} UNREAD`}</Text>
      </View>

      <View class="flex-col gap-1">
        {items.map((item, i) => (
          <NoticeRow
            key={item.id}
            item={item}
            index={i}
            rise={risingIds.current.includes(item.id) ? ROW_RISE_PX : 0}
            onRowRef={(id: string, row: NodeMirror) => {
              rowRefs.current.set(id, row);
            }}
            onDismiss={dismiss}
          />
        ))}
      </View>

      {items.length === 0 ? (
        <View class="grow flex-col items-center justify-center rounded-xl shadow bg-white border-slate-200">
          <Text class="text-sm text-slate-500">ALL CLEAR</Text>
        </View>
      ) : null}

      <Text class="text-xs text-slate-500">UP / DOWN move focus - CIRCLE dismiss</Text>
    </View>
  );
}
