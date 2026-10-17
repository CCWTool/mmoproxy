export function canDelegateUserPermissions(actor, targetUserId, permissions) {
    return targetUserId !== actor.id
        && Array.isArray(actor.permissions)
        && Array.isArray(permissions)
        && !permissions.includes('admin.users.permissions')
        && permissions.every((permission) => actor.permissions.includes(permission));
}

export function canChangeUserPermissions(actor, targetUserId, target) {
    if (targetUserId === actor.id
        || !Array.isArray(actor.permissions)
        || !Array.isArray(target?.permissions)) return false;

    const actorPermissions = new Set(actor.permissions);
    const targetPermissions = new Set(target.permissions);
    return targetPermissions.size < actorPermissions.size
        && [...targetPermissions].every((permission) => actorPermissions.has(permission));
}

export function canChangeUserPassword(actor, target) {
    if (!Array.isArray(actor.permissions) || !Array.isArray(target.permissions)) return false;

    const actorPermissions = new Set(actor.permissions);
    const targetPermissions = new Set(target.permissions);
    return targetPermissions.size < actorPermissions.size
        && [...targetPermissions].every((permission) => actorPermissions.has(permission));
}
