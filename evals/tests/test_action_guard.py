import json
from tau_bench.types import Action
from evals.action_guard import ObservedOrderGuard


def action(**changes):
    return Action(name='exchange_delivered_order_items', kwargs={'order_id': '#A', 'item_ids': ['old', 'old'],
        'new_item_ids': ['new1', 'new2'], 'payment_method_id': 'card'} | changes)


def test_guard_requires_observed_order_and_does_not_mix_units_between_orders():
    guard = ObservedOrderGuard()
    assert 'Read get_order_details' in guard.validate(action())
    guard.observe('get_order_details', json.dumps({'order_id': '#A', 'status': 'delivered',
        'items': [{'item_id': 'old', 'product_id': 'P'}, {'item_id': 'old', 'product_id': 'P'}]}))
    assert 'do not belong' in guard.validate(action(item_ids=['old', 'other-order-item']))
    assert 'Read get_product_details' in guard.validate(action())
    guard.observe('get_product_details', json.dumps({'product_id': 'P', 'variants': {
        'new1': {'available': True}, 'new2': {'available': True}, 'soldout': {'available': False}}}))
    assert guard.validate(action()) is None  # Two equal IDs are two units, not a set.
    assert 'quantities' in guard.validate(action(item_ids=['old', 'old', 'old']))
    assert 'Replacement' in guard.validate(action(new_item_ids=['new1', 'soldout']))
    assert 'exactly one' in guard.validate(action(new_item_ids=['new1']))


def test_successful_write_updates_observed_state_and_errors_do_not_replace_it():
    guard = ObservedOrderGuard()
    guard.observe('get_order_details', json.dumps({'order_id': '#A', 'status': 'delivered', 'items': [{'item_id': 'old'}]}))
    guard.observe('return_delivered_order_items', json.dumps({'order_id': '#A', 'status': 'return requested', 'items': [{'item_id': 'old'}]}))
    guard.observe('get_order_details', 'Error: order not found')
    assert 'does not permit' in guard.validate(action())
    assert guard.validate(Action(name='get_order_details', kwargs={'order_id': '#A'})) is None
