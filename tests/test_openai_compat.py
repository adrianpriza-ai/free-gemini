import http.client
import json
import threading
import unittest
from unittest import mock

from gemini_web2api.config import CONFIG
from gemini_web2api.server import GeminiHandler, ThreadedServer
from gemini_web2api.tools import parse_tool_calls, tool_names


class ParseToolCallsTests(unittest.TestCase):
    def test_canonical_fence(self):
        text = 'Thinking...\n```tool_call\n{"name": "read", "arguments": {"filePath": "a.txt"}}\n```\ndone'
        clean, calls = parse_tool_calls(text)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["function"]["name"], "read")
        self.assertEqual(json.loads(calls[0]["function"]["arguments"]), {"filePath": "a.txt"})
        self.assertEqual(calls[0]["type"], "function")
        self.assertTrue(calls[0]["id"].startswith("call_"))
        self.assertNotIn("tool_call", clean)

    def test_function_call_fence_variant(self):
        text = '```function_call\n{"name": "bash", "arguments": {"command": "ls"}}\n```'
        _, calls = parse_tool_calls(text)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["function"]["name"], "bash")

    def test_json_fence_with_name(self):
        text = '```json\n{"name": "read", "arguments": {"filePath": "a.txt"}}\n```'
        clean, calls = parse_tool_calls(text)
        self.assertEqual(len(calls), 1)
        self.assertEqual(clean, "")

    def test_json_fence_without_name_left_intact(self):
        text = 'Here is JSON:\n```json\n{"foo": 1}\n```'
        clean, calls = parse_tool_calls(text)
        self.assertEqual(calls, [])
        self.assertEqual(clean, text)

    def test_bracket_shorthand(self):
        text = 'Sure [tool_call: read {"filePath": "pyproject.toml"}] ok'
        clean, calls = parse_tool_calls(text)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["function"]["name"], "read")
        self.assertEqual(json.loads(calls[0]["function"]["arguments"]),
                         {"filePath": "pyproject.toml"})

    def test_bracket_shorthand_trailing_brace(self):
        # Observed in the wild: model appends an extra closing brace.
        text = '[tool_call: read { "filePath": "pyproject.toml" }}]'
        _, calls = parse_tool_calls(text)
        self.assertEqual(len(calls), 1)
        self.assertEqual(json.loads(calls[0]["function"]["arguments"]),
                         {"filePath": "pyproject.toml"})

    def test_raw_json_object(self):
        text = '{"name": "bash", "args": {"command": "pwd"}}'
        clean, calls = parse_tool_calls(text)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["function"]["name"], "bash")
        self.assertEqual(clean, "")

    def test_plain_prose_returns_no_calls(self):
        text = "The version is 1.1.0."
        clean, calls = parse_tool_calls(text)
        self.assertEqual(calls, [])
        self.assertEqual(clean, text)

    def test_valid_names_filters_hallucinated_tools(self):
        text = ('```tool_call\n{"name": "read", "arguments": {}}\n```\n'
                '```tool_call\n{"name": "nuke_drive", "arguments": {}}\n```')
        clean, calls = parse_tool_calls(text, {"read"})
        self.assertEqual([c["function"]["name"] for c in calls], ["read"])
        self.assertNotIn("nuke_drive", clean)

    def test_tool_names_helper(self):
        tools = [
            {"type": "function", "function": {"name": "read"}},
            {"type": "function", "function": {"name": "bash"}},
            {"name": "custom-thing"},
        ]
        self.assertEqual(tool_names(tools), {"read", "bash", "custom-thing"})
        self.assertEqual(tool_names(None), set())


class StreamingToolCallsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadedServer(("127.0.0.1", 0), GeminiHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def setUp(self):
        self.original_config = dict(CONFIG)
        CONFIG["api_keys"] = []
        CONFIG["log_requests"] = False

    def tearDown(self):
        CONFIG.clear()
        CONFIG.update(self.original_config)

    def post_json(self, path, payload):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.request("POST", path, body=json.dumps(payload),
                           headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        body = response.read().decode()
        connection.close()
        return response.status, body

    @mock.patch("gemini_web2api.server.generate")
    def test_streamed_tool_calls_carry_index_and_reassemble(self, generate):
        args = {"filePath": "pyproject.toml", "extra": "x" * 300}
        generate.return_value = (
            '```tool_call\n'
            + json.dumps({"name": "read", "arguments": args})
            + '\n```'
        )
        status, body = self.post_json("/v1/chat/completions", {
            "model": "gemini-3.6-flash",
            "messages": [{"role": "user", "content": "read the file"}],
            "stream": True,
            "tools": [{"type": "function", "function": {
                "name": "read",
                "parameters": {"type": "object"},
            }}],
        })
        self.assertEqual(status, 200)
        chunks = [json.loads(line[len("data: "):]) for line in body.splitlines()
                  if line.startswith("data: {")]
        # First chunk announces the assistant role.
        self.assertEqual(chunks[0]["choices"][0]["delta"], {"role": "assistant"})
        # Every tool_calls delta carries an index.
        tool_deltas = [c["choices"][0]["delta"] for c in chunks
                       if "tool_calls" in c["choices"][0]["delta"]]
        self.assertTrue(tool_deltas)
        for delta in tool_deltas:
            for tc in delta["tool_calls"]:
                self.assertIn("index", tc)
        # Head chunk carries id + name; arg slices reassemble exactly.
        head = tool_deltas[0]["tool_calls"][0]
        self.assertEqual(head["index"], 0)
        self.assertEqual(head["function"]["name"], "read")
        self.assertTrue(head["id"].startswith("call_"))
        reassembled = "".join(
            d["tool_calls"][0]["function"]["arguments"]
            for d in tool_deltas if d["tool_calls"][0].get("function", {}).get("arguments"))
        self.assertEqual(json.loads(reassembled), args)
        # Final chunk finishes with tool_calls reason.
        self.assertEqual(chunks[-1]["choices"][0]["finish_reason"], "tool_calls")
        self.assertTrue(body.endswith("data: [DONE]\n\n"))

    @mock.patch("gemini_web2api.server.generate")
    def test_streamed_unknown_tool_filtered(self, generate):
        generate.return_value = '```tool_call\n{"name": "evil", "arguments": {}}\n```'
        status, body = self.post_json("/v1/chat/completions", {
            "model": "gemini-3.6-flash",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
            "tools": [{"type": "function", "function": {"name": "read"}}],
        })
        self.assertEqual(status, 200)
        chunks = [json.loads(line[len("data: "):]) for line in body.splitlines()
                  if line.startswith("data: {")]
        self.assertEqual(chunks[-1]["choices"][0]["finish_reason"], "stop")
        self.assertNotIn("tool_calls", body)


if __name__ == "__main__":
    unittest.main()
