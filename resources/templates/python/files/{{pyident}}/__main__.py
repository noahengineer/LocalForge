from . import greeting


def main() -> None:
    print(greeting("{{name}}"))


if __name__ == "__main__":
    main()
