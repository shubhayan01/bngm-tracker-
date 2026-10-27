const jwt = require('jsonwebtoken');

// Roles and the business "Wings" each role may see/edit.
//
// THREE ACCESS LEVELS (user, 2026-08-17):
//   A. Department  — scoped to its own wing(s); sees/edits only its department.
//   B. Admin       — read-only reports across ALL departments EXCEPT Content.
//   C. Super       — everything.
//
// `wings`:  '*' = every wing (subject to `except`), or an explicit array of wings.
// `except`: only meaningful with wings '*' — wing names this role must NOT see.
// `readOnly`: role can view reports but cannot create/edit anything.
//
// TOOLS (user, 2026-09-21): EVERY department may ADD tools and edit/stop its OWN
// department's tools. `canManageTools` (Super only) is full control — it also edits
// shared "All departments" tools, edits any department's tools, and is the ONLY role
// that may DELETE a tool, so no department can ever remove another's data. Department
// roles get `canAddTools` instead: add + edit-own, never delete, never touch shared
// or other departments' tools.
const ROLES = {
  // C. Super — everything. Only Super can edit / delete clients (departments may
  // only add them) and assign a client to departments (user, 2026-08-21).
  super: { label: 'Super Admin', wings: '*', canCreateAccounts: true, canManageUsers: true, canEditSettings: true, canManageTools: true, canManageClients: true, canSwitchDept: true },

  // B. Digital Marketing (was "Admin") — full read/write across EVERY department
  // EXCEPT Content Creation (user, 2026-09-25): the Digital account must not see the
  // Content department at all; it sees/edits everything else via the top-bar switcher.
  // (user, 2026-09-14, #8). It cannot manage user accounts, edit global
  // assumptions/settings, or rename/delete/reassign clients (that stays Super-only).
  admin: { label: 'Digital Marketing', wings: '*', except: ['Content Creation'], canCreateAccounts: true, canManageUsers: false, canEditSettings: false, canManageTools: false, canAddTools: true, canManageClients: false, canSwitchDept: true },

  // Business Development — kept as a scoped department-style role. It has no delivery
  // wing of its own, so this starts empty; add wing names to grant visibility.
  bizdev: { label: 'Business Development', wings: [], canCreateAccounts: true, canManageUsers: false, canEditSettings: false, canManageTools: false, canAddTools: true },

  // A. Departments — each scoped to its own wing(s). Each may add + edit its own tools.
  seo: { label: 'SEO', wings: ['SEO', 'Guest Posting'], canCreateAccounts: true, canManageUsers: false, canEditSettings: false, canManageTools: false, canAddTools: true },
  // Guest Posting — its own department/login (user, 2026-09-25). SEO keeps seeing Guest
  // Posting too (it stays in seo.wings above), so this is an additional, independent login.
  guestposting: { label: 'Guest Posting', wings: ['Guest Posting'], canCreateAccounts: true, canManageUsers: false, canEditSettings: false, canManageTools: false, canAddTools: true },
  content: { label: 'Content', wings: ['Content Creation'], canCreateAccounts: true, canManageUsers: false, canEditSettings: false, canManageTools: false, canAddTools: true },
  social: { label: 'Social Media', wings: ['SMM'], canCreateAccounts: true, canManageUsers: false, canEditSettings: false, canManageTools: false, canAddTools: true },
  webdev: { label: 'Web Development', wings: ['Web Dev'], canCreateAccounts: true, canManageUsers: false, canEditSettings: false, canManageTools: false, canAddTools: true },
  perfmkt: { label: 'Performance Marketing', wings: ['Performance Mktg'], canCreateAccounts: true, canManageUsers: false, canEditSettings: false, canManageTools: false, canAddTools: true },
};

// Custom access profiles (user, 2026-10-27). Super can create their own admin-style
// logins from Assumptions — each is "full read/write across EVERY department except a
// chosen few" (same powers as Digital Marketing, different exclusions). They live in the
// datastore (`settings.adminProfiles`) and are registered here at boot and whenever Super
// edits them, so the rest of the app resolves them exactly like a built-in role. A custom
// profile can never grant user/settings/client management (those stay Super-only).
let CUSTOM = {};

// Build a role definition for a custom admin profile from its `except` wing list.
function profileDef(label, except) {
  return {
    label: String(label || 'Custom admin'),
    wings: '*',
    except: Array.isArray(except) ? except.slice() : [],
    canCreateAccounts: true, canManageUsers: false, canEditSettings: false,
    canManageTools: false, canAddTools: true, canManageClients: false,
    canSwitchDept: true, custom: true,
  };
}

// Replace the custom-profile registry from a stored list [{ key, label, except }].
// Keys that collide with a built-in role are ignored so built-ins can never be shadowed.
function setCustomProfiles(list) {
  const next = {};
  for (const p of (Array.isArray(list) ? list : [])) {
    const key = String(p && p.key || '').trim();
    if (!key || ROLES[key]) continue;
    next[key] = profileDef(p.label, p.except);
  }
  CUSTOM = next;
}

// Every role the app knows right now: built-ins plus registered custom profiles.
function allRoles() { return { ...ROLES, ...CUSTOM }; }
// Resolve one role (built-in or custom) to its definition, or undefined.
function getRole(role) { return allRoles()[role]; }

const JWT_SECRET =
  process.env.JWT_SECRET || 'jw-bngm-dev-secret-change-me-in-production-please';

function signToken(user) {
  return jwt.sign({ role: user.role }, JWT_SECRET, { expiresIn: '12h' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Does a role have access to a given wing?
function roleCanSeeWing(role, wing) {
  const r = getRole(role);
  if (!r) return false;
  if (r.wings === '*') return !(Array.isArray(r.except) && r.except.includes(wing));
  return r.wings.includes(wing);
}

// The list of wing names a role may see, given the full wing catalogue.
// Wildcard roles ('*') get every wing minus their `except` list; scoped roles
// get their own explicit list.
function visibleWings(role, allWings) {
  const r = getRole(role);
  if (!r) return [];
  if (r.wings === '*') return (allWings || []).filter((w) => roleCanSeeWing(role, w));
  return r.wings;
}



module.exports = {
  ROLES, signToken, verifyToken, roleCanSeeWing, visibleWings, JWT_SECRET,
  setCustomProfiles, allRoles, getRole, profileDef,
};
