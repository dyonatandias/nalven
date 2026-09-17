ALTER TABLE "pos_admin_mutations"
  DROP CONSTRAINT "pos_admin_mutations_action_check";

ALTER TABLE "pos_admin_mutations"
  ADD CONSTRAINT "pos_admin_mutations_action_check" CHECK ("action" IN (
    'register.create', 'register.update', 'register.deactivate',
    'terminal.create', 'terminal.update', 'terminal.deactivate',
    'device.create', 'device.update', 'device.deactivate',
    'connector.create', 'connector.update', 'connector.deactivate',
    'terminal.pairing.issue', 'terminal.token.rotate', 'terminal.revoke',
    'promotion.create', 'promotion.update', 'promotion.deactivate',
    'coupon.create', 'coupon.update', 'coupon.rotate', 'coupon.deactivate'
  ));
