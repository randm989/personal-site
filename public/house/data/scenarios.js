// Simulator scenarios for the real house (data/house.json + data/bindings.json). Edit alongside them.
//
// Each scenario is a table: entity id → { state, attributes, ago, reportedAgo, silent, clear }
//   ago          minutes since the state last changed
//   reportedAgo  minutes since the entity was last heard from (default: a few minutes)
//   silent       the device has stopped reporting (it stays quiet while the simulator runs)
//   clear        drop the entity's attributes (what Home Assistant does for 'unavailable')
// Entities a table does not name start in a quiet default (off, closed, locked, clear, idle, phone away).
// 'empty' needs no table; 'offline' starts as 'evening' unless given its own.
// An entity id that is not in bindings.json is reported on the console and ignored.

const lightOn = (pct, kelvin, ago) => ({
  state: 'on', ago,
  attributes: { brightness: Math.round(pct * 2.55), color_temp_kelvin: kelvin, color_mode: 'color_temp' },
});
const onOff = (ago) => ({ state: 'on', ago, attributes: { color_mode: 'onoff' } });
const temp = (v) => ({ state: v.toFixed(1) });
/** A phone: where it is, its battery, and whether it is on charge. */
const phone = (who, room, battery, charge, ago = 20) => ({
  [`sensor.${who}_phone_room`]: { state: room, ago },
  [`sensor.${who}_phone_battery_level`]: { state: String(battery), ago: 9 },
  [`sensor.${who}_phone_battery_state`]: { state: charge, ago: charge === 'not_charging' ? 240 : 55 },
});

// A lived-in evening: the family room lit, a game on the PlayStation, a print two-thirds done upstairs,
// one phone downstairs and one in the game room, the car on charge, and a window left open.
const evening = {
  'light.family_room': lightOn(55, 2700, 140),
  'light.family_room_lamp': lightOn(40, 2400, 140),
  'light.kitchen': lightOn(80, 3500, 95),
  'light.hall': lightOn(40, 2700, 60),
  'light.foyer': lightOn(30, 2700, 22),
  'light.porch': onOff(130),
  'light.game_room_lamp': lightOn(35, 2400, 48),
  'light.study': lightOn(60, 4000, 100),

  'media_player.family_room_tv': { state: 'on', ago: 71, attributes: { source: 'PlayStation 5' } },
  'media_player.playstation': { state: 'playing', ago: 68, attributes: { media_title: 'Astro Bot', media_content_type: 'game', source: 'PlayStation 5' } },
  'sensor.dryer_status': { state: 'running', ago: 26 },
  'sensor.printer_3d_status': { state: 'printing', ago: 78 },
  'sensor.printer_3d_progress': { state: '62', ago: 1 },
  'sensor.printer_3d_remaining': { state: '47', ago: 1 },

  'person.josh': { state: 'home', ago: 190 },
  ...phone('josh', 'Family Room', 64, 'not_charging', 68),
  'person.housemate': { state: 'home', ago: 310 },
  ...phone('housemate', 'Game Room', 12, 'not_charging', 48),      // upstairs, and nearly flat

  'binary_sensor.car_in_garage': { state: 'on', ago: 190 },
  'binary_sensor.car_charging': { state: 'on', ago: 187 },
  'binary_sensor.family_room_presence': { state: 'on', ago: 68 },
  'binary_sensor.game_room_motion': { state: 'on', ago: 1 },
  'binary_sensor.kitchen_motion': { state: 'off', ago: 17 },
  'binary_sensor.hall_motion': { state: 'off', ago: 9 },
  'binary_sensor.breakfast_window_contact': { state: 'on', ago: 38 },
  'cover.primary_bedroom_blind': { state: 'open', ago: 160, attributes: { current_position: 50 } },

  // Indoor cameras: the family room one is live; the game room one has its lens shut (privacy) while someone is in there.
  'camera.family_room': { state: 'idle', ago: 190 },
  'binary_sensor.family_room_camera_motion': { state: 'off', ago: 4 },
  'binary_sensor.family_room_camera_person': { state: 'off', ago: 12 },
  'camera.game_room': { state: 'off', ago: 48 },

  'sensor.hall_temperature': temp(21.6),
  'sensor.hall_humidity': { state: '46' },
  'sensor.game_room_temperature': temp(22.3),
  'sensor.primary_bedroom_temperature': temp(20.9),
  'sensor.study_temperature': temp(23.1),
  'sensor.garage_temperature': temp(15.4),
  'climate.downstairs': { state: 'heat', ago: 400, attributes: { hvac_action: 'heating', current_temperature: 21.6, temperature: 22 } },
  'climate.upstairs': { state: 'heat', ago: 400, attributes: { hvac_action: 'idle', current_temperature: 22.3, temperature: 21 } },
  'sensor.outdoor_temperature': temp(12),
  'alarm_control_panel.home': { state: 'disarmed', ago: 190 },
};

// Night: armed, everything sensed is shut, both phones on charge in the primary bedroom, the print done.
const quiet = {
  'light.bedside_lamp': lightOn(12, 2200, 35),
  'light.hall': lightOn(8, 2200, 200),
  'alarm_control_panel.home': { state: 'armed_home', ago: 65 },

  'person.josh': { state: 'home', ago: 420 },
  ...phone('josh', 'Primary Bedroom', 81, 'charging', 62),
  'person.housemate': { state: 'home', ago: 540 },
  ...phone('housemate', 'Primary Bedroom', 100, 'full', 70),

  'sensor.printer_3d_status': { state: 'finished', ago: 95 },
  'sensor.printer_3d_progress': { state: '100', ago: 95 },
  'sensor.printer_3d_remaining': { state: '0', ago: 95 },

  'binary_sensor.car_in_garage': { state: 'on', ago: 420 },
  'binary_sensor.car_charging': { state: 'on', ago: 418 },
  'binary_sensor.family_room_presence': { state: 'off', ago: 75 },
  'cover.primary_bedroom_blind': { state: 'closed', ago: 75, attributes: { current_position: 0 } },

  'sensor.hall_temperature': temp(20.1),
  'sensor.hall_humidity': { state: '48' },
  'sensor.game_room_temperature': temp(20.4),
  'sensor.primary_bedroom_temperature': temp(19.6),
  'sensor.study_temperature': temp(20.2),
  'sensor.garage_temperature': temp(12.8),
  'climate.downstairs': { state: 'heat', ago: 400, attributes: { hvac_action: 'idle', current_temperature: 20.1, temperature: 19 } },
  'climate.upstairs': { state: 'heat', ago: 400, attributes: { hvac_action: 'idle', current_temperature: 20.4, temperature: 19 } },
  'sensor.outdoor_temperature': temp(6),
};

// Nobody home, armed away: someone is standing in the driveway, and the garage door was left open.
const away = {
  'light.porch': onOff(45),
  'light.driveway': onOff(45),
  'alarm_control_panel.home': { state: 'armed_away', ago: 188 },
  'person.josh': { state: 'not_home', ago: 190 },
  ...phone('josh', 'not_home', 71, 'not_charging', 190),
  'person.housemate': { state: 'not_home', ago: 205 },
  ...phone('housemate', 'not_home', 44, 'not_charging', 205),

  'cover.garage_door': { state: 'open', ago: 189, attributes: { current_position: 100 } },
  'binary_sensor.car_in_garage': { state: 'off', ago: 189 },
  'camera.driveway': { state: 'recording', ago: 1 },
  'binary_sensor.driveway_camera_motion': { state: 'on', ago: 1 },
  'binary_sensor.driveway_camera_person': { state: 'on', ago: 1 },
  'binary_sensor.driveway_motion': { state: 'on', ago: 1 },
  // Nobody home: both indoor cameras are watching, and see nothing.
  'camera.family_room': { state: 'idle', ago: 188 },
  'camera.game_room': { state: 'idle', ago: 188 },

  'sensor.hall_temperature': temp(18.2),
  'sensor.hall_humidity': { state: '50' },
  'sensor.game_room_temperature': temp(18.6),
  'sensor.primary_bedroom_temperature': temp(17.9),
  'sensor.study_temperature': temp(18.3),
  'sensor.garage_temperature': temp(14.0),
  'climate.downstairs': { state: 'heat', ago: 188, attributes: { hvac_action: 'idle', current_temperature: 18.2, temperature: 17 } },
  'climate.upstairs': { state: 'heat', ago: 188, attributes: { hvac_action: 'idle', current_temperature: 18.6, temperature: 17 } },
  'sensor.outdoor_temperature': temp(14),
};

// The evening, with water on the laundry floor two minutes ago.
const alert = {
  ...evening,
  'binary_sensor.laundry_leak': { state: 'on', ago: 2 },
  'binary_sensor.hall_smoke': { state: 'off', ago: 9000 },
  'binary_sensor.game_room_smoke': { state: 'off', ago: 9000 },
};

// The quiet night, with three things that stopped talking: a camera that dropped off the network, a door
// contact whose battery died three days ago, and a phone whose room reading is forty minutes old.
const stale = {
  ...quiet,
  'camera.back_yard': { state: 'unavailable', ago: 300, clear: true, silent: true },
  'binary_sensor.back_yard_camera_motion': { state: 'unavailable', ago: 300, clear: true, silent: true },
  'binary_sensor.back_yard_camera_person': { state: 'unavailable', ago: 300, clear: true, silent: true },
  'binary_sensor.front_door_contact': { state: 'off', ago: 3 * 1440 + 200, reportedAgo: 3 * 1440, silent: true },
  'sensor.josh_phone_room': { state: 'Primary Bedroom', ago: 62, reportedAgo: 40, silent: true },
};

export const scenarios = { evening, quiet, away, alert, stale };
export default scenarios;
