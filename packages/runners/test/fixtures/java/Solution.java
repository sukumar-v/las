import java.util.Scanner;

public class Solution {
    static int add(int a, int b) {
        return a + b;
    }

    static int countWords(String s) {
        String t = s.trim();
        return t.isEmpty() ? 0 : t.split("\\s+").length;
    }

    static int divide(int a, int b) {
        return a / b;
    }

    static int spin() {
        while (true) {
        }
    }

    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        String name = in.nextLine().trim();
        System.out.println("Hello, " + name + "!");
    }
}
