import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    canChangeUserPassword,
    canChangeUserPermissions,
    canDelegateUserPermissions,
} from '../../src/backend/permission-delegation.js';

const actor = {
    id: 1,
    permissions: ['user.login', 'user.plan.read', 'admin.users.permissions', 'admin.users.read'],
};

test('allows delegating only existing permissions to another user', () => {
    assert.equal(canDelegateUserPermissions(actor, 2, ['user.login', 'admin.users.read']), true);
    assert.equal(canDelegateUserPermissions(actor, 2, []), true);
    assert.equal(canDelegateUserPermissions(actor, 2, ['admin.pool.read']), false);
    assert.equal(canDelegateUserPermissions(actor, 2, ['admin.users.permissions']), false);
});

test('does not allow changing the actor own permissions', () => {
    assert.equal(canDelegateUserPermissions(actor, actor.id, ['user.login']), false);
});

test('allows permission changes only for targets with a strict subset of actor permissions', () => {
      assert.equal(canChangeUserPermissions(actor, 2, { permissions: ['user.login'] }), true);
      assert.equal(canChangeUserPermissions(actor, 2, { permissions: [] }), true);
      assert.equal(canChangeUserPermissions(actor, 2, { permissions: [...actor.permissions] }), false);
      assert.equal(canChangeUserPermissions(actor, 2, {
          permissions: [...actor.permissions, 'admin.pool.read'],
      }), false);
      assert.equal(canChangeUserPermissions(actor, 2, {
          permissions: ['user.login', 'admin.pool.read'],
      }), false);
      assert.equal(canChangeUserPermissions(actor, actor.id, { permissions: ['user.login'] }), false);
});

test('allows password changes only for users with a strict subset of actor permissions', () => {
    assert.equal(canChangeUserPassword(actor, { permissions: ['user.login'] }), true);
    assert.equal(canChangeUserPassword(actor, { permissions: [...actor.permissions] }), false);
    assert.equal(canChangeUserPassword(actor, {
        permissions: [...actor.permissions, 'admin.pool.read'],
    }), false);
    assert.equal(canChangeUserPassword(actor, {
        permissions: ['user.login', 'admin.pool.read'],
    }), false);
});
