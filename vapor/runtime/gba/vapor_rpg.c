/* vapor/runtime/gba/vapor_rpg.c -- fixed GBA pixel host for Pocket Vapor RPGs.
 *
 * Gameplay remains compiler-generated reactive C.  This file owns only ROM
 * map queries and a small Mode 0 renderer: BG1 is the pixel world, BG0 is the
 * existing (now transparent) Vapor font, and OBJ contains the actors.
 */
#include "vapor.h"
#include "vapor_rpg_assets.generated.h"

#define REG16(addr) (*(volatile u16 *)(addr))
#define REG_DISPCNT REG16(0x04000000)
#define REG_BG1CNT REG16(0x0400000a)
#define REG_BG1HOFS REG16(0x04000014)
#define REG_BG1VOFS REG16(0x04000016)

#define PAL_BG ((volatile u16 *)0x05000000)
#define PAL_OBJ ((volatile u16 *)0x05000200)
#define FONT_VRAM ((volatile u16 *)0x06000000)
#define RPG_BG_VRAM ((volatile u16 *)0x06008000) /* charblock 2 */
#define RPG_BG_MAP ((volatile u16 *)0x06004800)  /* screenblock 9 */
#define RPG_OBJ_VRAM ((volatile u16 *)0x06010000)
#define OAM ((volatile u16 *)0x07000000)

#define RPG_BG_BANK 15
#define RPG_ENTRY(tile) ((u16)((tile) | (RPG_BG_BANK << 12)))
#define RPG_OBJ_PRIORITY (1 << 10)

enum {
  TILE_BLANK,
  TILE_GRASS_A,
  TILE_GRASS_B,
  TILE_PATH_A,
  TILE_PATH_B,
  TILE_WALL,
  TILE_WATER_A,
  TILE_WATER_B,
  TILE_TREE,
  TILE_FLOWER,
  TILE_BOX_FILL,
  TILE_BOX_TOP,
  TILE_BOX_BOTTOM,
  TILE_BOX_LEFT,
  TILE_BOX_RIGHT,
  TILE_BOX_TL,
  TILE_BOX_TR,
  TILE_BOX_BL,
  TILE_BOX_BR,
  TILE_BATTLE_SKY,
  TILE_BATTLE_GROUND,
  TILE_HP_EMPTY,
  TILE_HP_FULL,
  TILE_HUD,
  TILE_COUNT
};

typedef char vp_rpg_bg_tile_count_must_match[
    TILE_COUNT == VP_RPG_BG_TILE_COUNT ? 1 : -1];

static u16 rpg_bg_shadow[32 * 32];
static u16 rpg_oam_shadow[128 * 4];
static u8 rpg_bg_dirty;
static u8 rpg_oam_dirty;
static u8 rpg_ready;

static void upload_transparent_font(void) {
  volatile u16 *dst = FONT_VRAM + 16; /* tile zero remains transparent */
  u16 i;
  for (i = 0; i < 95 * 16; i++) {
    u8 a = vp_font_tiles[(u16)i * 2];
    u8 b = vp_font_tiles[(u16)i * 2 + 1];
    u8 lo = (u8)(a & 15);
    u8 hi = (u8)(a >> 4);
    if (lo == 2) lo = 0;
    if (hi == 2) hi = 0;
    a = (u8)(lo | (hi << 4));
    lo = (u8)(b & 15);
    hi = (u8)(b >> 4);
    if (lo == 2) lo = 0;
    if (hi == 2) hi = 0;
    b = (u8)(lo | (hi << 4));
    dst[i] = (u16)(a | ((u16)b << 8));
  }
}

static void hide_objects(void) {
  u16 i;
  for (i = 0; i < 128; i++) {
    rpg_oam_shadow[i * 4] = 0x0200;
    rpg_oam_shadow[i * 4 + 1] = 0;
    rpg_oam_shadow[i * 4 + 2] = 0;
    rpg_oam_shadow[i * 4 + 3] = 0;
  }
  rpg_oam_dirty = 1;
}

static void show_object(u8 slot, s16 x, s16 y, u8 tile, u8 palette) {
  u16 at = (u16)slot * 4;
  rpg_oam_shadow[at] = (u16)(y & 0x00ff); /* square, regular OBJ */
  rpg_oam_shadow[at + 1] = (u16)((x & 0x01ff) | 0x4000); /* 16x16 */
  rpg_oam_shadow[at + 2] = (u16)(tile | RPG_OBJ_PRIORITY |
                                    ((u16)palette << 12));
  rpg_oam_shadow[at + 3] = 0;
  rpg_oam_dirty = 1;
}

static void show_object_32(u8 slot, s16 x, s16 y, u8 tile, u8 palette) {
  u16 at = (u16)slot * 4;
  rpg_oam_shadow[at] = (u16)(y & 0x00ff); /* square, regular OBJ */
  rpg_oam_shadow[at + 1] = (u16)((x & 0x01ff) | 0x8000); /* 32x32 */
  rpg_oam_shadow[at + 2] = (u16)(tile | RPG_OBJ_PRIORITY |
                                    ((u16)palette << 12));
  rpg_oam_shadow[at + 3] = 0;
  rpg_oam_dirty = 1;
}

static void map_fill(u8 tile) {
  u16 i;
  u16 entry = RPG_ENTRY(tile);
  for (i = 0; i < 32 * 32; i++) rpg_bg_shadow[i] = entry;
  rpg_bg_dirty = 1;
}

static void map_cell(u8 x, u8 y, u8 tile) {
  if (x < 32 && y < 32)
    rpg_bg_shadow[(u16)y * 32 + x] = RPG_ENTRY(tile);
}

static u8 world_tile(u8 ch, u8 x, u8 y) {
  if (ch == '#') return TILE_WALL;
  if (ch == '=' || ch == ':' || ch == 'p')
    return ((x + y) & 1) ? TILE_PATH_A : TILE_PATH_B;
  if (ch == '~') return ((x + y) & 1) ? TILE_WATER_A : TILE_WATER_B;
  if (ch == 'T' || ch == 't') return TILE_TREE;
  if (ch == '*') return TILE_FLOWER;
  return ((x + y) & 1) ? TILE_GRASS_A : TILE_GRASS_B;
}

static void line_text(u8 row, u8 x, const char *text) {
  vp_ln_reset();
  if (text) vp_ln_str(text);
  vp_ln_commit(row, x, 0, VP_ALIGN_LEFT);
}

static void line_hp(u8 row, u8 x, s32 hp, s32 max_hp) {
  vp_ln_reset();
  vp_ln_str("HP ");
  vp_ln_int(hp);
  vp_ln_ch('/');
  vp_ln_int(max_hp);
  vp_ln_commit(row, x, 0, VP_ALIGN_LEFT);
}

static void line_choice(u8 row, u8 x, const char *text, u8 selected) {
  vp_ln_reset();
  vp_ln_ch(selected ? '>' : ' ');
  vp_ln_ch(' ');
  if (text) vp_ln_str(text);
  vp_ln_commit(row, x, 0, VP_ALIGN_LEFT);
}

static void draw_box(u8 left, u8 top, u8 right, u8 bottom) {
  u8 x, y;
  map_cell(left, top, TILE_BOX_TL);
  map_cell(right, top, TILE_BOX_TR);
  map_cell(left, bottom, TILE_BOX_BL);
  map_cell(right, bottom, TILE_BOX_BR);
  for (x = (u8)(left + 1); x < right; x++) {
    map_cell(x, top, TILE_BOX_TOP);
    map_cell(x, bottom, TILE_BOX_BOTTOM);
  }
  for (y = (u8)(top + 1); y < bottom; y++) {
    map_cell(left, y, TILE_BOX_LEFT);
    map_cell(right, y, TILE_BOX_RIGHT);
    for (x = (u8)(left + 1); x < right; x++)
      map_cell(x, y, TILE_BOX_FILL);
  }
}

static void draw_world(const vp_rpg_map *map, s32 player_x, s32 player_y,
                       u8 facing, s32 quest, u8 hud) {
  u8 x, y, ox, oy, slot;
  u16 at;
  map_fill(TILE_BLANK);
  hide_objects();
  if (!map || !map->tiles || !map->width || !map->height) return;
  ox = map->width < 30 ? (u8)((30 - map->width) >> 1) : 0;
  oy = map->height < 20 ? (u8)((20 - map->height) >> 1) : 0;
  for (y = 0; y < map->height && (u8)(oy + y) < 20; y++) {
    for (x = 0; x < map->width && (u8)(ox + x) < 30; x++) {
      at = (u16)y * map->width + x;
      map_cell((u8)(ox + x), (u8)(oy + y),
               world_tile(map->tiles[at], x, y));
    }
  }
  slot = 1;
  for (y = 0; y < map->height && slot < 127; y++) {
    for (x = 0; x < map->width && slot < 127; x++) {
      u8 ch = map->tiles[(u16)y * map->width + x];
      if (ch == 'N') {
        show_object(slot++, (s16)((ox + x) * 8 - 4),
                    (s16)((oy + y) * 8 - 8), 16, 1);
      } else if (ch == 'S' && quest == 1) {
        show_object(slot++, (s16)((ox + x) * 8 - 4),
                    (s16)((oy + y) * 8 - 8), 20, 2);
      }
    }
  }
  if (player_x >= 0 && player_y >= 0 && player_x < map->width &&
      player_y < map->height) {
    u8 hero_tile = facing < 4 ? (u8)(facing * 4) : 0;
    show_object(0, (s16)((ox + player_x) * 8 - 4),
                (s16)((oy + player_y) * 8 - 8), hero_tile, 0);
  }
  if (hud) {
    for (x = 0; x < 30; x++) map_cell(x, 0, TILE_HUD);
    if (quest == 0) line_text(0, 1, "QUEST: TALK TO THE ELDER");
    else if (quest == 1) line_text(0, 1, "QUEST: DEFEAT THE SLIME");
    else if (quest == 2) line_text(0, 1, "QUEST: RETURN TO THE ELDER");
    else line_text(0, 1, "QUEST COMPLETE: VILLAGE SAVED");
  }
}

static void draw_dialog(const vp_rpg_map *map, s32 player_x, s32 player_y,
                        u8 facing, s32 quest, s32 dialog, s32 choice) {
  const vp_rpg_dialog *d;
  draw_world(map, player_x, player_y, facing, quest, 0);
  draw_box(1, 11, 28, 19);
  if (!map || !map->dialogs || dialog < 1 || dialog > map->dialog_count) {
    line_text(15, 3, "...");
    return;
  }
  d = &map->dialogs[dialog - 1];
  line_text(12, 3, d->speaker);
  line_text(14, 3, d->line1);
  line_text(15, 3, d->line2);
  if (d->choice0 && d->choice0[0])
    line_choice(17, 3, d->choice0, choice == 0);
  if (d->choice1 && d->choice1[0])
    line_choice(18, 3, d->choice1, choice == 1);
}

static u8 hp_tiles(s32 hp, s32 max_hp) {
  if (hp <= 0 || max_hp <= 0) return 0;
  if (hp >= max_hp) return 10;
  return (u8)((hp * 10 + max_hp - 1) / max_hp);
}

static void draw_battle(s32 hero_hp, s32 enemy_hp, s32 cursor) {
  u8 x, y, full;
  hide_objects();
  for (y = 0; y < 32; y++)
    for (x = 0; x < 32; x++)
      rpg_bg_shadow[(u16)y * 32 + x] =
          RPG_ENTRY(y < 11 ? TILE_BATTLE_SKY : TILE_BATTLE_GROUND);
  rpg_bg_dirty = 1;
  full = hp_tiles(enemy_hp, 18);
  for (x = 0; x < 10; x++)
    map_cell((u8)(18 + x), 4, x < full ? TILE_HP_FULL : TILE_HP_EMPTY);
  full = hp_tiles(hero_hp, 30);
  for (x = 0; x < 10; x++)
    map_cell((u8)(2 + x), 13, x < full ? TILE_HP_FULL : TILE_HP_EMPTY);
  draw_box(2, 14, 27, 19);
  show_object_32(0, 32, 56, VP_RPG_BATTLE_HERO_TILE, 0);
  show_object_32(1, 176, 40, VP_RPG_BATTLE_SLIME_TILE, 2);
  line_text(1, 17, "WILD SLIME");
  line_hp(2, 18, enemy_hp, 18);
  line_text(10, 2, "HERO");
  line_hp(11, 2, hero_hp, 30);
  line_choice(15, 4, "ATTACK", cursor == 0);
  line_choice(17, 4, "HEAL", cursor == 1);
}

u8 vp_rpg_blocked(const vp_rpg_map *map, s32 x, s32 y) {
  u32 at;
  if (!map || x < 0 || y < 0 || x >= map->width || y >= map->height)
    return 1;
  if (!map->solid) return 0;
  at = (u32)y * map->width + (u32)x;
  return map->solid[at] ? 1 : 0;
}

u8 vp_rpg_event_at(const vp_rpg_map *map, s32 x, s32 y) {
  u8 tile, i;
  u32 at;
  if (!map || !map->tiles || !map->events || x < 0 || y < 0 ||
      x >= map->width || y >= map->height)
    return 0;
  at = (u32)y * map->width + (u32)x;
  tile = map->tiles[at];
  for (i = 0; i < map->event_count; i++)
    if (map->events[i].tile == tile) return map->events[i].event;
  return 0;
}

void vp_rpg_video_init(void) {
  u16 i;
  upload_transparent_font();
  for (i = 0; i < 16; i++) {
    PAL_BG[RPG_BG_BANK * 16 + i] = vp_rpg_bg_palette[i];
  }
  for (i = 0; i < 3 * 16; i++) PAL_OBJ[i] = vp_rpg_obj_palettes[i];
  for (i = 0; i < VP_RPG_BG_TILE_COUNT * 16; i++)
    RPG_BG_VRAM[i] = vp_rpg_bg_tiles[i];
  for (i = 0; i < VP_RPG_OBJ_TILE_COUNT * 16; i++)
    RPG_OBJ_VRAM[i] = vp_rpg_obj_tiles[i];
  map_fill(TILE_BLANK);
  hide_objects();
  REG_BG1CNT = (u16)(2 | (2 << 2) | (9 << 8));
  REG_BG1HOFS = 0;
  REG_BG1VOFS = 0;
  REG_DISPCNT = 0x1340;
  rpg_ready = 1;
}

void vp_rpg_render(const vp_rpg_map *map, u8 mode, s32 player_x,
                   s32 player_y, u8 facing, s32 quest, s32 dialog,
                   s32 choice, s32 hero_hp, s32 enemy_hp,
                   s32 battle_cursor) {
  if (!rpg_ready) return;
  vp_row_clear(0, VP_GRID_H);
  if (mode == 1)
    draw_dialog(map, player_x, player_y, facing, quest, dialog, choice);
  else if (mode == 2)
    draw_battle(hero_hp, enemy_hp, battle_cursor);
  else
    draw_world(map, player_x, player_y, facing, quest, 1);
}

void vp_rpg_video_commit(void) {
  u16 i;
  if (!rpg_ready) return;
  if (rpg_bg_dirty) {
    for (i = 0; i < 32 * 32; i++) RPG_BG_MAP[i] = rpg_bg_shadow[i];
    rpg_bg_dirty = 0;
  }
  if (rpg_oam_dirty) {
    for (i = 0; i < 128 * 4; i++) OAM[i] = rpg_oam_shadow[i];
    rpg_oam_dirty = 0;
  }
}
