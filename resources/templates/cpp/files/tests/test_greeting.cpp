#include <cstdlib>
#include <iostream>
#include "greeting.hpp"

int main() {
    const auto g = greeting("test");
    if (g != "Hello, test!") {
        std::cerr << "unexpected greeting: " << g << '\n';
        return EXIT_FAILURE;
    }
    std::cout << "all tests passed\n";
    return EXIT_SUCCESS;
}
