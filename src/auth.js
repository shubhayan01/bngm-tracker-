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
  const r = ROLES[role];
  if (!r) return false;
  if (r.wings === '*') return !(Array.isArray(r.except) && r.except.includes(wing));
  return r.wings.includes(wing);
}

// The list of wing names a role may see, given the full wing catalogue.
// Wildcard roles ('*') get every wing minus their `except` list; scoped roles
// get their own explicit list.
function visibleWings(role, allWings) {
  const r = ROLES[role];
  if (!r) return [];
  if (r.wings === '*') return (allWings || []).filter((w) => roleCanSeeWing(role, w));
  return r.wings;
}



module.exports = { ROLES, signToken, verifyToken, roleCanSeeWing, visibleWings, JWT_SECRET };
