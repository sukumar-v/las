#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

int add(int a, int b) { return a + b; }

int count_words(const std::string& s) {
    std::istringstream in(s);
    std::string w;
    int n = 0;
    while (in >> w) n++;
    return n;
}

int divide(int a, int b) {
    if (b == 0) throw std::invalid_argument("division by zero");
    return a / b;
}

std::vector<int> squares(int n) {
    std::vector<int> v;
    for (int i = 1; i <= n; i++) v.push_back(i * i);
    return v;
}

int spin() {
    volatile unsigned long n = 0;
    for (;;) n++;
}

int main() {
    std::string name;
    std::getline(std::cin, name);
    std::cout << "Hello, " << name << "!" << std::endl;
}
