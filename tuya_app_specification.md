# Feature Specification: Smart Control Custom App

This document describes the functional features, user experience, and behavior rules of the **Smart Control** application. It serves as a product requirements guide for Tuya's development team to duplicate the features of the current system into a custom app.

---

## 1. Device Dashboard & Control

### Live Device Grid
- **Overview**: The app displays a grid of all connected lighting and dimming devices.
- **Connection Status**: Each device card clearly shows whether the device is **Online** (ready) or **Offline** (unreachable).
- **Core Info**: Displays the device's name, its power state (ON/OFF), its current brightness level, and its active mode (e.g., White-Light Mode).
- **Hardware Filtering**: Gateway devices are filtered out from the main dashboard, ensuring users only see controllable light fixtures.
- **Individual Controls**: 
  - Direct buttons to turn a device **ON** or **OFF** instantly.
  - A dimmer slider (range 10 to 1000) to adjust brightness. 

---

## 2. Shops (Organizational Locations)

- **Overview**: A "Shop" represents a physical location or area (e.g., "Downtown Storefront", "Back Office"). It is used strictly for organizing and filtering devices.
- **Shop Management**: 
  - Users can create new shops, rename existing shops, or delete them.
  - Users can assign any device to a specific shop or leave it "Unassigned".
- **Dashboard Filtering**:
  - A navigation bar at the top allows users to filter the dashboard by selecting a shop.
  - Selecting a shop displays only the devices and groups assigned to that shop.
  - Users can also filter for "Unassigned" devices or view "All Shops" at once.
- **Safety Rule on Deletion**: Deleting a shop does **not** delete the devices inside it. Instead, those devices are automatically set back to "Unassigned," and any groups inside that shop are removed.

---

## 3. Custom Lighting Groups

- **Overview**: Groups allow users to control multiple devices together (e.g., "Storefront window signs", "Office overhead lights").
- **Group Management**:
  - Users can create groups, update their member list, or delete them.
  - A group must belong to a specific shop.
- **Group Membership Constraints**:
  - **One Group Per Device**: A device can only belong to one group at a time. Adding a device to a new group automatically removes it from its previous group.
  - **Shop Alignment**: A device can only join a group if it already belongs to the group's shop. Moving a device to a different shop automatically removes it from its group.
- **Group Controls**:
  - Direct buttons to turn all group members **ON** or **OFF** simultaneously.
  - A single dimmer slider to adjust the brightness of all group members at once.
- **Independent Group State (Sticky Targets)**:
  - A group card displays a single ON/OFF state and a single brightness slider.
  - This status represents the *target state* set by the user, not a calculated average of member states. The group card's settings remain fixed on what the user last set, rather than resetting or jumping if individual devices report different levels.

---

## 4. Automatic State Synchronization (Anti-Drift)

To ensure that group members always match the group's settings, the app runs an automatic synchronization process in the background. This resolves discrepancies caused by devices being offline during a group command, newly added devices, or manual overrides (physical switches / other apps).

- **Power Synchronization**:
  - If a device in a group is online but its current power state does not match the group's target state, the app automatically sends a correction command to turn that specific device ON or OFF.
- **Brightness Synchronization**:
  - If an online device's brightness differs from the group's target brightness by more than a small tolerance (10 units), the app automatically corrects it.
- **Guard Rails**:
  - The synchronization process only targets the specific drifted devices (rather than spamming commands to the entire group).
  - If the group's target state is **OFF**, the synchronization process will never turn any member device ON during brightness adjustments.

---

## 5. Daily Automation & Schedules

- **Overview**: Users can automate lighting schedules for individual devices or groups.
- **Timer Rules**:
  - Users can set daily recurring timers specifying a target time (Hour:Minute) and action (Turn ON or Turn OFF).
  - When configuring a "Turn ON" schedule, users can optionally set a specific brightness level.
  - There is a maximum limit of **10 schedules** per device or group.
- **Schedule Overrides**:
  - When a device is added to a group, its individual schedules are deleted. This prevents conflicting commands between individual device timers and group timers.
- **Dynamic Group Schedules**:
  - When a group timer triggers, the app must dynamically check which devices belong to the group *at that exact moment* and apply the commands. This ensures new group members are automatically included, and former members are ignored.
