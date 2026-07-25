# SPARKWOOD acceptance run.
#
# Wake up at home, cross the village, take a partner from the professor, walk
# out to Route One and win the first wild battle. The whole opening.
#
# Tapes describe intent, never frame counts:
#   walk  <udlr> <cells>    hold a direction until that many steps land
#   press <udlrabse>        one edge-detected button press
#   clear [presses]         press A until nothing is waiting to be read
#   grind <dd> [cap]        pace between two directions until a battle starts
#   wait  <frames>          idle (fades, message holds)
#   mark  <name>            capture + hash the frame

mark  00-wake

# --- out of the house ----------------------------------------------------
walk  d 4
walk  r 4
wait  40
mark  01-village

# --- across the village to the lab ---------------------------------------
walk  d 4
walk  r 6
walk  u 4
wait  40
mark  02-inside-lab

# --- the professor, and a partner ----------------------------------------
walk  u 2
walk  l 2
press u
mark  03-facing-professor
press a
# One `clear` runs the professor's whole script: two pages of greeting, the
# choice (A on the first option takes EMBERKIT), and the parting gift. Pressing
# A again afterwards would just start the conversation over — the player is
# still standing nose to nose with him.
clear 40
mark  04-partner-in-hand

# --- out of the lab, north out of the village ----------------------------
walk  d 2
walk  r 2
wait  40
mark  06-back-outside
walk  d 4
walk  l 3
walk  u 9
walk  u 1
wait  40
mark  07-route-one

# --- the first wild battle ------------------------------------------------
walk  u 3
mark  08-in-the-grass
grind ud 900
wait  20
mark  09-wild-appears
clear
mark  10-action-menu
press a
wait  20
mark  11-move-menu
fight
mark  12-battle-over

# --- and again, to prove the loop repeats ---------------------------------
grind ud 900
wait  20
mark  13-second-encounter
fight
mark  14-still-standing
