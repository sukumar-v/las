use std::io::Read;

fn add(a: i64, b: i64) -> i64 {
    a + b
}

fn count_words(s: &str) -> usize {
    s.split_whitespace().count()
}

fn divide(a: i64, b: i64) -> i64 {
    if b == 0 {
        panic!("division by zero");
    }
    a / b
}

fn spin() -> i64 {
    loop {
        std::hint::spin_loop();
    }
}

fn main() {
    let mut name = String::new();
    std::io::stdin().read_to_string(&mut name).unwrap();
    println!("Hello, {}!", name.trim());
}
