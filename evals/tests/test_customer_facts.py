from evals.customer_facts import ungrounded_facts


def test_source_checks_known_instruction_and_observed_facts_without_reference_answers():
    instruction = 'You are Yusuf in 19122, email y.rossi@example.com. Use the address in the other order.'
    history = [{'role': 'user', 'content': 'Order #W2378156 has item 1151293680 and ships to 476 Maple Drive.'}]
    assert ungrounded_facts('ZIP code 19122, y.rossi@example.com; order W2378156, item 1151293680, 476 Maple Drive.', instruction, history) == []
    unknown = ungrounded_facts('Use 123 Central Park West and fake@example.com for #W9999999.', instruction, history)
    assert {x['kind'] for x in unknown} == {'address', 'email', 'order_id'}
    assert ungrounded_facts('I do not remember it. Could you look it up?', instruction, history) == []


def test_deliberately_false_task_claims_are_allowed_and_repair_system_text_is_not_evidence():
    assert ungrounded_facts('My email is deliberate@example.com', 'Claim your email is deliberate@example.com', []) == []
    assert ungrounded_facts('fake@example.com', '', [{'role': 'system', 'content': 'Example fake@example.com'}])
