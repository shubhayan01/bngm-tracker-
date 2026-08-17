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
const ROLES = {
  // C. Super — everything.
  super: { label: 'Super Admin', wings: '*', canCreateAccounts: true, canManageUsers: true, canEditSettings: true, canManageTools: true },

  // B. Admin — reports of all departments except Content. Read-only.
  admin: { label: 'Admin', wings: '*', except: ['Content Creation'], readOnly: true, canCreateAccounts: false, canManageUsers: false, canEditSettings: false, canManageTools: false },

  // Business Development — kept as a scoped department-style role. It has no delivery
  // wing of its own, so this starts empty; add wing names to grant visibility.
  bizdev: { label: 'Business Development', wings: [], canCreateAccounts: true, canManageUsers: false, canEditSettings: false, canManageTools: true },

  // A. Departments — each scoped to its own wing(s).
  seo: { label: 'SEO', wings: ['SEO', 'Guest Posting'], canCreateAccounts: true, canManageUsers: false, canEditSettings: false, canManageTools: false },
  content: { label: 'Content', wings: ['Content Creation'], canCreateAccounts: true, canManageUsers: false, canEditSettings: false, canManageTools: false },
  social: { label: 'Social Media', wings: ['SMM'], canCreateAccounts: true, canManageUsers: false, canEditSettings: false, canManageTools: false },
  webdev: { label: 'Web Development', wings: ['Web Dev'], canCreateAccounts: true, canManageUsers: false, canEditSettings: false, canManageTools: false },
  perfmkt: { label: 'Performance Marketing', wings: ['Performance Mktg'], canCreateAccounts: true, canManageUsers: false, canEditSettings: false, canManageTools: false },
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
