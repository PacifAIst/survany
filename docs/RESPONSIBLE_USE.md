# Responsible use

Survey Anything points a camera or a screen at the world and tells people when something happens. Used
well, it watches a 3D printer, a server room, a shop queue or an empty house. Used badly, it watches
people who did not agree to it. This page is the longer version of the consent screen the extension shows
before its first capture.

**Not legal advice.** The law on cameras and automated monitoring differs by country and changes. If
you are unsure whether a use is lawful where you are, ask a lawyer or your data protection authority.

## What it will never do

These are product boundaries, not settings. There is no flag to turn them on:

- **No face recognition, person re-identification or emotion inference.** Recipes that ask a model to
  identify who someone is, or how they feel, are refused at import.
- **No hidden mode.** While a camera or tab is being watched, the extension's badge says so. While a live
  stream is open, a "Streaming to …" banner and notification are shown, and the stream cannot start until
  they are visible.
- **No audio.** Capture is video only.
- **No autonomous contact with emergency services.** It alerts a person; a person decides to call. No
  policy can enable a tool that dials or messages police, fire or ambulance services.
- **No device action without a person.** Every action needs a tap on a Telegram card; silence means no.

## Before you point it at something

- **Your own space, your own screens.** Watching your empty home, your workshop, your dashboards or a
  device is the intended use.
- **People who live or work there.** Tell them, and where the law requires it, get their consent. Domestic
  employees and caregivers are workers: recording them usually brings employment and data protection
  obligations that a household camera does not have.
- **Public space.** Do not aim at the street, a neighbour's property or shared areas beyond what is
  unavoidable. In Spain, for example, the data protection authority (AEPD) treats a camera limited to a
  home's interior as household use, but that exemption ends when it records public space beyond a minimal
  strip or records household employees or caregivers.
- **Someone else's screen or account.** Watching a tab means watching whatever it shows. Do not watch
  another person's accounts, messages or camera feeds without their permission.
- **The EU AI Act.** Real-time remote biometric identification in publicly accessible spaces is
  restricted under Article 5, and the high-risk rules for biometric systems apply from 2 December 2027.
  This product does no biometric identification, and the boundaries above keep it that way.

## Where your images go

What leaves your machine depends on your settings (details in `docs/PRIVACY_POLICY.md`):

- With a **local model** and **Allow cloud AI providers** off, frames stay on your machine and your own
  network.
- With a **cloud model**, the frame that triggered a candidate goes to that provider.
- **Alert media** (snapshots and 10-second clips) go to Telegram and email only when you turn it on.
  Telegram and email are not end-to-end encrypted for these messages.
- **Live view** sends a stream to your own OvenMediaEngine server, viewable only by the alerted contacts,
  for at most 10 minutes per link.

## It is not a safety device

The detectors and models make mistakes. The fire/smoke detector misses about 3 in 10 smoke-only frames at
its default setting, and a sign in front of the camera can sometimes talk a model out of confirming an
event (both measured, see `docs/BENCHMARKS.md`). Keep your smoke alarms, your alarm system and your common
sense. Use this as an extra pair of eyes, not the only one.
