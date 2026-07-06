from app.services.agent_llm import format_proxy_console_message


def test_proxy_console_message_simplified():
    text = format_proxy_console_message(
        "Hi echo they eat chicken in China",
        "How would you like me to answer this in the meeting?",
        reason="Routing could not run; please reply so Echo can respond.",
    )
    assert text == (
        "Hi in the meeting I was asked, 'Hi echo they eat chicken in China', "
        "give me an answer and I will communicate it in the meeting."
    )


def test_proxy_console_message_without_trigger():
    text = format_proxy_console_message("", "Please share your view", reason=None)
    assert text == "Hi, I need your answer so I can respond in the meeting."
