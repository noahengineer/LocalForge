import unittest

from {{pyident}} import greeting


class GreetingTest(unittest.TestCase):
    def test_greeting(self) -> None:
        self.assertEqual(greeting("test"), "Hello from test!")


if __name__ == "__main__":
    unittest.main()
