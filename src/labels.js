// -----------------------------------------------------------------------------
// The words the integration shows, in the four languages of the manifest.
//
// WHY A FILE OF ITS OWN
// Texts come from two places and are not interchangeable:
//   - the MANIFEST carries the Configuration screen, the widget name and the
//     scene labels. There a text is a language map and Gladys picks the language;
//   - the CODE builds the widget content at runtime, and in that vocabulary a
//     label is a single string. So the runtime texts live here and the caller
//     passes the language it wants.
//
// WHICH LANGUAGE? The language of the Gladys interface is not sent to the
// integration, so it cannot be followed automatically. These texts are German,
// which matches the manifest (German first) and the device's own audience.
// Everything Gladys renders from the manifest is translated properly; only the
// strings this file produces are fixed.
//
// A STATE, SAID IN ONE SENTENCE — AND WHY THAT IS THE POINT OF THIS FILE
// The user does not want to read "2" next to a label called "Ladezustand" and
// then look up what 2 means. The widget says what is happening: it charges with
// so many kilowatts, it is ready, the cable is plugged in but the car is not,
// something is wrong. That sentence is built here.
//
// THE DEVICE REPORTS A NUMBER, AND THE FREE TEXT IS KEYED BY WORD
// `1000` holds 0 for "available", 2 for "charging", 8 for "faulted". The keys in
// TEXT below are the WORDS, because a text that was keyed by number would be
// unreadable in this file and would have to be renamed if the device ever
// reordered its list.
//
// That means the translation between the two shapes has to happen somewhere, and
// it happens here — in stateSentence(). It was MISSING at first, and the card
// showed the bare key: `stateSentence({ chargepoint_state: 0 })` built the string
// "state_0", found no such text, and `t()` fell back to the key itself. The state
// is published as a number (see src/devices/wallbox.js) and the words live here,
// so this function is the only place the two meet. Nothing else may build a
// state key from a raw register value.
//
// WHY EVERY KEY IS ADDED IN ALL FOUR LANGUAGES AT ONCE
// `t()` falls back to the key itself when a translation is missing, so a text
// added in German only would show the literal key to an English user. That
// happened in the WattWächter integration, where the card asked for a text that
// did not exist yet and showed the bare key instead.
// -----------------------------------------------------------------------------

import { CHARGEPOINT_STATE, CABLE_STATE } from './vestel/registers.js';

/** The language every runtime text falls back to. */
export const LANGUAGE = 'de';

/**
 * The chargepoint states of the device, each as a sentence.
 *
 * `state_charging` and `state_faulted` take a value and are functions rather
 * than strings: a sentence about a number cannot be a fixed text.
 */
export const TEXT = {
  de: {
    notConnected: 'Keine Verbindung zur Wallbox. Adresse in der Konfiguration prüfen.',
    state_available: 'Verfügbar – kein Fahrzeug angeschlossen.',
    state_preparing: 'Fahrzeug erkannt, Ladevorgang wird vorbereitet.',
    state_charging: (kw) => `Ich lade aktuell mit ${kw} kW.`,
    state_suspended_evse: 'Ladevorgang pausiert – die Wallbox wartet.',
    state_suspended_ev: 'Ladevorgang pausiert – das Fahrzeug entscheidet.',
    state_finishing: 'Ladevorgang wird abgeschlossen.',
    state_reserved: 'Für ein Fahrzeug reserviert.',
    state_unavailable: 'Gesperrt – die Wallbox ist nicht freigegeben.',
    state_faulted: (code) => `Störung${code ? ` (Code ${code})` : ''}.`,
    state_unknown: 'Zustand unbekannt.',
    cable_unplugged: 'Kein Kabel angeschlossen.',
    cable_plugged: 'Kabel angeschlossen, Fahrzeug nicht.',
    cable_vehicle: 'Kabel angeschlossen, Fahrzeug verbunden.',
    cable_locked: 'Kabel verriegelt.',
    power: 'Ladeleistung',
    current: 'Ladestrom',
    energy: 'Geladene Energie',
    meter: 'Zählerstand',
    control: (a) => `Ladestrom auf ${a} A gesetzt.`,
    reading: 'Werte werden gelesen …',
  },
  en: {
    notConnected: 'No connection to the wallbox. Check the address in the configuration.',
    state_available: 'Available – no vehicle connected.',
    state_preparing: 'Vehicle detected, charging is being prepared.',
    state_charging: (kw) => `Currently charging at ${kw} kW.`,
    state_suspended_evse: 'Charging paused – the wallbox is waiting.',
    state_suspended_ev: 'Charging paused – the vehicle decides.',
    state_finishing: 'Finishing the charging session.',
    state_reserved: 'Reserved for a vehicle.',
    state_unavailable: 'Unavailable – the wallbox is not released.',
    state_faulted: (code) => `Fault${code ? ` (code ${code})` : ''}.`,
    state_unknown: 'State unknown.',
    cable_unplugged: 'No cable connected.',
    cable_plugged: 'Cable connected, no vehicle.',
    cable_vehicle: 'Cable connected, vehicle connected.',
    cable_locked: 'Cable locked.',
    power: 'Charging power',
    current: 'Charging current',
    energy: 'Energy charged',
    meter: 'Meter reading',
    control: (a) => `Charging current set to ${a} A.`,
    reading: 'Reading the values…',
  },
  fr: {
    notConnected: 'Pas de connexion à la borne. Vérifiez l’adresse dans la configuration.',
    state_available: 'Disponible – aucun véhicule connecté.',
    state_preparing: 'Véhicule détecté, la charge se prépare.',
    state_charging: (kw) => `Je charge actuellement à ${kw} kW.`,
    state_suspended_evse: 'Charge en pause – la borne attend.',
    state_suspended_ev: 'Charge en pause – le véhicule décide.',
    state_finishing: 'Fin de la charge en cours.',
    state_reserved: 'Réservée à un véhicule.',
    state_unavailable: 'Indisponible – la borne n’est pas libérée.',
    state_faulted: (code) => `Défaut${code ? ` (code ${code})` : ''}.`,
    state_unknown: 'État inconnu.',
    cable_unplugged: 'Aucun câble connecté.',
    cable_plugged: 'Câble connecté, pas de véhicule.',
    cable_vehicle: 'Câble connecté, véhicule connecté.',
    cable_locked: 'Câble verrouillé.',
    power: 'Puissance de charge',
    current: 'Courant de charge',
    energy: 'Énergie chargée',
    meter: 'Index',
    control: (a) => `Courant de charge réglé à ${a} A.`,
    reading: 'Lecture des valeurs…',
  },
  es: {
    notConnected: 'Sin conexión con el cargador. Comprueba la dirección en la configuración.',
    state_available: 'Disponible: ningún vehículo conectado.',
    state_preparing: 'Vehículo detectado, se prepara la carga.',
    state_charging: (kw) => `Estoy cargando a ${kw} kW.`,
    state_suspended_evse: 'Carga en pausa: el cargador espera.',
    state_suspended_ev: 'Carga en pausa: decide el vehículo.',
    state_finishing: 'Terminando la carga.',
    state_reserved: 'Reservado para un vehículo.',
    state_unavailable: 'Bloqueado: el cargador no está liberado.',
    state_faulted: (code) => `Avería${code ? ` (código ${code})` : ''}.`,
    state_unknown: 'Estado desconocido.',
    cable_unplugged: 'Ningún cable conectado.',
    cable_plugged: 'Cable conectado, sin vehículo.',
    cable_vehicle: 'Cable conectado, vehículo conectado.',
    cable_locked: 'Cable bloqueado.',
    power: 'Potencia de carga',
    current: 'Corriente de carga',
    energy: 'Energía cargada',
    meter: 'Lectura del contador',
    control: (a) => `Corriente de carga fijada en ${a} A.`,
    reading: 'Leyendo los valores…',
  },
};

/**
 * Look a text up.
 *
 * An unknown key returns the key itself rather than throwing: a missing word
 * should never be the reason a card stays empty. That fallback is also why a
 * new key belongs in all four languages at once — otherwise the key itself is
 * what the user reads.
 */
export function t(key, language = LANGUAGE) {
  return TEXT[language]?.[key] ?? TEXT[LANGUAGE][key] ?? key;
}

/**
 * A register value as the WORD the text table is keyed by.
 *
 * `table` is the one the register map declares for that register, so this
 * function invents no vocabulary of its own: `CHARGEPOINT_STATE[2]` is
 * 'charging', and that is the word found in TEXT. An unknown or missing value
 * answers `null`, and the caller decides what to say about it.
 */
export function stateWord(value, table) {
  if (value === null || value === undefined) return null;
  const word = table?.[value];
  return typeof word === 'string' && word.length > 0 ? word : null;
}

/**
 * The charge state as one sentence the user can act on.
 *
 * THE ONE PLACE A REGISTER VALUE BECOMES A SENTENCE
 * `chargepoint_state` arrives as a NUMBER, straight from register 1000, because
 * that is the only shape Gladys accepts for a state it has to compare. The texts
 * are keyed by WORD. This function is where those two meet:
 *
 *   number  ->  CHARGEPOINT_STATE  ->  word  ->  `state_<word>`  ->  sentence
 *
 * Any other path would build a key like `state_0` and get the key back, which is
 * exactly what happened on the first real start.
 *
 * A state function is called with the fault code, because a bare "Störung"
 * leaves the user with nothing to look up.
 */
export function stateSentence(snapshot, language = LANGUAGE) {
  const word = stateWord(snapshot?.chargepoint_state, CHARGEPOINT_STATE);
  const text = t(word ? `state_${word}` : 'state_unknown', language);
  return typeof text === 'function' ? text(snapshot?.fault_code ?? '') : text;
}

/**
 * The cable state as one sentence.
 *
 * Same shape as the charge state, and the same reason: register 1004 is a number,
 * the texts are keyed by word. `cable_unknown` is deliberately not a text of its
 * own — an unknown cable state falls back to the charge state's "unknown", which
 * says the same thing without a second key to keep in four languages.
 */
export function cableSentence(snapshot, language = LANGUAGE) {
  const word = stateWord(snapshot?.cable_state, CABLE_STATE);
  if (!word) return t('state_unknown', language);
  return t(`cable_${word}`, language);
}

/**
 * The charging power as the number a sentence shows, in kilowatts.
 *
 * The device reports watts, and a sentence that says "11000 Watt" is one nobody
 * reads twice. One decimal, and no trailing ",0".
 */
export function powerInKw(snapshot) {
  const watts = snapshot?.power;
  if (typeof watts !== 'number') return '?';
  const kw = Math.round(watts / 100) / 10;
  return Number.isInteger(kw) ? String(kw) : kw.toFixed(1).replace('.', ',');
}

/**
 * The whole state of the device as ONE sentence, power included.
 *
 * `state_charging` is the only sentence that talks about a number, so the number
 * is filled in here rather than baked into the text table. Every other sentence is
 * a fixed string.
 */
export function deviceSentence(snapshot, language = LANGUAGE) {
  const word = stateWord(snapshot?.chargepoint_state, CHARGEPOINT_STATE);
  if (word === 'charging') {
    return t('state_charging', language)(powerInKw(snapshot));
  }
  return stateSentence(snapshot, language);
}
