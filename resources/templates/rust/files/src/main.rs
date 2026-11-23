fn greeting(name: &str) -> String {
    format!("Hello from {name}!")
}

fn main() {
    println!("{}", greeting("{{name}}"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greets() {
        assert_eq!(greeting("test"), "Hello from test!");
    }
}
