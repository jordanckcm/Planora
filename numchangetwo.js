const number = document.getElementById("randomNumbertwo");

setInterval(() => {
    let result = "";

    for (let i = 0; i < 2; i++) {
        result += Math.floor(Math.random() * 10);
    }

    number.textContent = result;
}, 100);